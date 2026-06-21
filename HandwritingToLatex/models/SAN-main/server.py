"""
SAN Handwriting Recognition API Server

A FastAPI server that loads the SAN model and exposes a /recognize endpoint.
Accepts a PNG image of handwritten math and returns recognized LaTeX.
Runs on port 8001.
"""

import io
import logging
import math
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Tuple

import numpy as np
import torch
import uvicorn
import yaml
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

# ── Path setup: add SAN source to sys.path ──────────────────────────
SAN_DIR = str(Path(__file__).resolve().parent)
sys.path.insert(0, SAN_DIR)

from dataset import Words
from infer.Backbone import Backbone
from utils import load_checkpoint

# DenseNet downsampling factor (config.yaml: densenet.ratio).  The encoder
# shrinks the spatial dimensions by this factor, so the input H/W must be a
# multiple of it for the attention mask to align with the CNN feature map.
RATIO = 16

# Target ink height for scale normalization.  The SAN checkpoint is highly
# scale-sensitive: it produces correct output for heights ~50–120px but
# degrades to garbage above ~140px.  Browser-rasterized images arrive at
# 2–4× this scale (devicePixelRatio on Retina), so we normalize the height
# to 96px (6×RATIO) before padding.  Empirically verified to produce correct,
# high-confidence predictions for both up-scaled and down-scaled inputs.
TARGET_H = 96

# ── Constants ──────────────────────────────────────────────────────────
MAX_UPLOAD_SIZE_MB = 10
MAX_UPLOAD_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024
CONFIG_PATH = str(Path(__file__).resolve().parent / "config.yaml")
CHECKPOINT_PATH = str(Path(__file__).resolve().parent / "checkpoints" / "SAN_decoder" / "best.pth")

# ── Logging ───────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# ── Model globals ─────────────────────────────────────────────────────
model: Backbone = None
words: Words = None
device = torch.device(
    "cuda" if torch.cuda.is_available()
    else "mps" if torch.backends.mps.is_available()
    else "cpu"
)


# ── Helpers ───────────────────────────────────────────────────────────

def load_config(config_path):
    """Load only the parameters needed for inference from the YAML config."""
    with open(config_path, 'r') as f:
        params = yaml.load(f, Loader=yaml.FullLoader)

    # Set inference-only params
    params['device'] = device
    # Override checkpoint path
    params['checkpoint'] = CHECKPOINT_PATH
    # Set dummy paths for fields load_config normally requires for training
    params['train_image_path'] = ''
    params['train_label_path'] = ''
    params['eval_image_path'] = ''
    params['eval_label_path'] = ''

    return params


def pad_pil_to_ratio(pil_img: Image.Image) -> Image.Image:
    """Pad a grayscale PIL image so H and W are multiples of RATIO.

    The DenseNet encoder downsamples by RATIO (16), so the input spatial
    dimensions must be multiples of 16 for the attention mask to align with
    the CNN feature map.  Padding uses the background value (white) so the
    pad pixels become black after colour inversion, matching the CROHME
    background distribution the model was trained on.

    NOTE: The SAN checkpoint was trained on CROHME images at their *natural*
    aspect ratio (no fixed-height resize); the config's image_height/image_width
    are only batch-filter bounds, not resize targets.  Resizing whiteboard
    crops to a fixed 320x1600 canvas destroys the scale the model expects and
    causes the decoder to emit '\log \log \log ...' garbage.  Empirically
    verified: natural size + invert gives correct, high-confidence output.
    """
    if pil_img.mode != "L":
        pil_img = pil_img.convert("L")

    w, h = pil_img.size
    if h == 0 or w == 0:
        # Degenerate input; return a single RATIO x RATIO white tile
        return Image.new("L", (RATIO, RATIO), 255)

    ph = (RATIO - h % RATIO) % RATIO
    pw = (RATIO - w % RATIO) % RATIO
    if ph == 0 and pw == 0:
        return pil_img

    canvas = Image.new("L", (w + pw, h + ph), 255)
    canvas.paste(pil_img, (0, 0))
    return canvas


def normalize_height(pil_img: Image.Image) -> Image.Image:
    """Resize a grayscale PIL image so its height is TARGET_H, preserving
    aspect ratio.

    The SAN checkpoint is highly scale-sensitive: it produces correct output
    for heights ~50-120px but degrades to garbage above ~140px.  Browser-
    rasterized images arrive at 2-4x the training scale (devicePixelRatio on
    Retina), so we normalize the height to TARGET_H (96px) before padding.
    Empirically verified across up-scaled and down-scaled inputs.
    """
    if pil_img.mode != "L":
        pil_img = pil_img.convert("L")

    w, h = pil_img.size
    if h == 0 or w == 0:
        return Image.new("L", (RATIO, RATIO), 255)

    if h == TARGET_H:
        return pil_img

    scale = TARGET_H / h
    new_w = max(int(round(w * scale)), 1)
    return pil_img.resize((new_w, TARGET_H), Image.Resampling.LANCZOS)


def preprocess_image(pil_img: Image.Image) -> Tuple[torch.Tensor, torch.Tensor]:
    """Convert a PIL image to a [1, 1, H, W] tensor and a [1, 1, H, W] mask.

    Steps:
        1. Convert to grayscale
        2. Normalize height to TARGET_H (scale normalization — the model is
           highly scale-sensitive; browser images arrive at 2-4x training scale)
        3. Pad H/W up to a multiple of RATIO so the DenseNet feature map
           aligns with the downsampled mask
        4. Invert colours (whiteboard is black-on-white, CROHME is white-on-black)
        5. Convert to tensor and normalize to [0, 1]
        6. Create an all-ones mask (matching the reference inference.py)
    """
    pil_img = normalize_height(pil_img)
    pil_img = pad_pil_to_ratio(pil_img)

    img_np = np.array(pil_img, dtype=np.float32)

    # SAN model was trained on CROHME-format images (white ink on black
    # background, normalized to [0,1]). Our whiteboard produces
    # black-on-white, so we invert to match training distribution.
    img_np = 255.0 - img_np
    img_np = img_np / 255.0

    # Convert to tensor: [H, W] -> [1, 1, H, W]
    img_tensor = torch.from_numpy(img_np).unsqueeze(0).unsqueeze(0)

    # Create mask: all pixels valid (matches the reference inference.py,
    # which uses torch.ones(image.shape)).
    _, _, h, w = img_tensor.shape
    mask = torch.ones((1, 1, h, w), dtype=torch.float32)

    return img_tensor, mask


def convert_tree_to_latex(nodeid, gtd_list):
    """Convert the tree-format prediction from SAN model into a LaTeX string.

    This is adapted from the SAN inference.py script.
    """
    isparent = False
    child_list = []
    for i in range(len(gtd_list)):
        if gtd_list[i][2] == nodeid:
            isparent = True
            child_list.append([gtd_list[i][0], gtd_list[i][1], gtd_list[i][3]])
    if not isparent:
        return [gtd_list[nodeid][0]]
    else:
        if gtd_list[nodeid][0] == '\\frac':
            return_string = [gtd_list[nodeid][0]]
            for i in range(len(child_list)):
                if child_list[i][2] == 'Above':
                    return_string += ['{'] + convert_tree_to_latex(child_list[i][1], gtd_list) + ['}']
            for i in range(len(child_list)):
                if child_list[i][2] == 'Below':
                    return_string += ['{'] + convert_tree_to_latex(child_list[i][1], gtd_list) + ['}']
            for i in range(len(child_list)):
                if child_list[i][2] == 'Right':
                    return_string += convert_tree_to_latex(child_list[i][1], gtd_list)
            for i in range(len(child_list)):
                if child_list[i][2] not in ['Right', 'Above', 'Below']:
                    return_string += ['illegal']
        else:
            return_string = [gtd_list[nodeid][0]]
            for i in range(len(child_list)):
                if child_list[i][2] in ['l_sup']:
                    return_string += ['['] + convert_tree_to_latex(child_list[i][1], gtd_list) + [']']
            for i in range(len(child_list)):
                if child_list[i][2] == 'Inside':
                    return_string += ['{'] + convert_tree_to_latex(child_list[i][1], gtd_list) + ['}']
            for i in range(len(child_list)):
                if child_list[i][2] in ['Sub', 'Below']:
                    return_string += ['_', '{'] + convert_tree_to_latex(child_list[i][1], gtd_list) + ['}']
            for i in range(len(child_list)):
                if child_list[i][2] in ['Sup', 'Above']:
                    return_string += ['^', '{'] + convert_tree_to_latex(child_list[i][1], gtd_list) + ['}']
            for i in range(len(child_list)):
                if child_list[i][2] in ['Right']:
                    return_string += convert_tree_to_latex(child_list[i][1], gtd_list)
        return return_string


# ── Lifespan ─────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: load model. Shutdown: cleanup (if needed)."""
    global model, words

    # Load config
    if not Path(CONFIG_PATH).exists():
        logger.error(f"Config not found at {CONFIG_PATH}")
        yield
        return

    params = load_config(CONFIG_PATH)

    # Load vocabulary
    if not Path(params['word_path']).exists():
        logger.error(f"Vocabulary not found at {params['word_path']}")
        yield
        return

    words = Words(params['word_path'])
    params['word_num'] = len(words)
    params['struct_num'] = 7
    params['words'] = words

    logger.info(f"Loaded vocabulary: {len(words)} symbols")

    # Load model
    logger.info(f"Loading checkpoint from {CHECKPOINT_PATH} ...")
    if not Path(CHECKPOINT_PATH).exists():
        logger.error(f"Checkpoint not found at {CHECKPOINT_PATH}")
        yield
        return

    try:
        model = Backbone(params=params)
        load_checkpoint(model, None, CHECKPOINT_PATH)
    except Exception as exc:
        logger.exception("Failed to load model checkpoint")
        model = None
        yield
        return

    model.eval()
    model.to(device)
    logger.info("Model loaded successfully on %s.", device)
    yield


# ── App instance (use lifespan) ─────────────────────────────────────────
app = FastAPI(title="SAN HWR API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Endpoints ───────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": model is not None}


@app.post("/recognize")
async def recognize(file: UploadFile = File(...)):
    """Recognize handwritten math from an uploaded PNG image.

    Returns:
        {"candidates": [...], "top": {"latex": "...", "score": 0}}
    """
    if model is None:
        raise HTTPException(status_code=503, detail="Model is not loaded yet.")

    # Read with size limit
    try:
        contents = await file.read()
        if not contents:
            raise HTTPException(status_code=400, detail="Empty image file.")
        if len(contents) > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"Image too large. Maximum size is {MAX_UPLOAD_SIZE_MB} MB."
            )
        pil_img = Image.open(io.BytesIO(contents))
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to read uploaded image")
        raise HTTPException(
            status_code=400,
            detail=f"Could not read image: {exc}"
        ) from exc

    try:
        img_tensor, img_mask = preprocess_image(pil_img)
    except Exception as exc:
        logger.exception("Failed to preprocess image")
        raise HTTPException(status_code=500, detail=f"Preprocessing failed: {exc}") from exc

    img_tensor = img_tensor.to(device)
    img_mask = img_mask.to(device)

    start = time.time()
    try:
        with torch.no_grad():
            tree_result, mean_log_prob = model(img_tensor, img_mask)
    except Exception as exc:
        logger.exception("Model inference failed")
        raise HTTPException(status_code=500, detail=f"Inference failed: {exc}") from exc
    elapsed = time.time() - start

    # Convert tree result to LaTeX string
    latex_list = convert_tree_to_latex(1, tree_result)
    latex_string = ' '.join(latex_list)

    # Convert mean log-prob to a confidence score in [0, 1]
    confidence = round(math.exp(mean_log_prob), 4) if mean_log_prob > float('-inf') else 0.0

    logger.info(f"Recognized in {elapsed:.2f}s: {latex_string!r} (confidence={confidence:.4f})")

    return {
        "candidates": [{"latex": latex_string, "score": confidence, "log_prob": round(mean_log_prob, 4)}],
        "top": {"latex": latex_string, "score": confidence, "log_prob": round(mean_log_prob, 4)}
    }


if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8001, reload=False)