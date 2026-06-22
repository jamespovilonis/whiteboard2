"""
CAN Handwriting Recognition API Server

A FastAPI server that loads the CAN model and exposes a /recognize endpoint.
Accepts a PNG image of handwritten math and returns recognized LaTeX.
Runs on port 8002.
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

# ── Path setup: add CAN source to sys.path ──────────────────────────
CAN_DIR = str(Path(__file__).resolve().parent / "CAN-main")
sys.path.insert(0, CAN_DIR)

# Load models/ submodules via importlib to bypass models/__init__.py,
# which would otherwise trigger a chain of imports (decoder → counting_utils
# → matplotlib) that are not needed for inference.
import importlib.util as _ilutil

def _load_module_direct(name, relpath):
    """Load a .py file as a module, bypassing package __init__.py."""
    spec = _ilutil.spec_from_file_location(name, str(Path(CAN_DIR) / relpath))
    mod = _ilutil.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod

# decoder.py has a top-level `from counting_utils import gen_counting_label`
# which pulls in matplotlib.  Provide a dummy counting_utils module so that
# decoder.py can load without heavyweight training-only dependencies.
import types as _types
_dummy_cu = _types.ModuleType("counting_utils")
def _dummy_gen_counting_label(labels, channel, tag):
    # Return a zero tensor with shape (batch, channel) so that
    # infer_model.forward() can compute loss without crashing.
    # The loss value is discarded during inference.
    b = labels.size(0)
    return torch.zeros((b, channel), device=labels.device)
_dummy_cu.gen_counting_label = _dummy_gen_counting_label
sys.modules["counting_utils"] = _dummy_cu

_models_densenet = _load_module_direct("models.densenet", "models/densenet.py")
_models_attention = _load_module_direct("models.attention", "models/attention.py")
_models_decoder = _load_module_direct("models.decoder", "models/decoder.py")
_models_counting = _load_module_direct("models.counting", "models/counting.py")

# Now load infer_model — its "from models.xxx import ..." will find the
# pre-loaded modules in sys.modules and skip models/__init__.py.
_infer_mod = _load_module_direct("models.infer_model", "models/infer_model.py")
Inference = _infer_mod.Inference

from dataset import Words
from utils import load_checkpoint

# DenseNet downsampling factor (config.yaml: densenet.ratio).  The encoder
# shrinks the spatial dimensions by this factor, so the input H/W must be a
# multiple of it for the attention mask to align with the CNN feature map.
RATIO = 16

# Target ink height for scale normalization (same as SAN).
TARGET_H = 96

# ── Constants ──────────────────────────────────────────────────────────
MAX_UPLOAD_SIZE_MB = 10
MAX_UPLOAD_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024
CONFIG_PATH = str(Path(__file__).resolve().parent / "CAN-main" / "config.yaml")
WORD_PATH = str(Path(__file__).resolve().parent / "CAN-main" / "datasets" / "CROHME" / "words_dict.txt")

# ── Logging ───────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# ── Model globals ─────────────────────────────────────────────────────
model: Inference = None
words: Words = None
device = torch.device(
    "cuda" if torch.cuda.is_available()
    else "mps" if torch.backends.mps.is_available()
    else "cpu"
)


# ── Helpers ───────────────────────────────────────────────────────────

def load_config(yaml_path):
    """Load only the parameters needed for inference from the YAML config."""
    with open(yaml_path, 'r') as f:
        params = yaml.load(f, Loader=yaml.FullLoader)

    params['device'] = device
    params['word_path'] = WORD_PATH
    # Set dummy paths for fields load_config normally requires for training
    params['train_image_path'] = ''
    params['train_label_path'] = ''
    params['eval_image_path'] = ''
    params['eval_label_path'] = ''

    return params


def find_best_checkpoint(checkpoints_dir: str) -> str:
    """Find the best checkpoint .pth file in the checkpoints directory.

    Looks for the most recent checkpoint directory and returns the best
    checkpoint file within it (preferring files with 'best' in the name).
    """
    checkpoints_path = Path(checkpoints_dir)
    if not checkpoints_path.exists():
        return None

    # Find all .pth files recursively
    pth_files = list(checkpoints_path.rglob("*.pth"))
    if not pth_files:
        return None

    # Prefer files with 'best' in the name
    best_files = [f for f in pth_files if 'best' in f.name.lower()]
    if best_files:
        # Return the most recently modified
        best_files.sort(key=lambda f: f.stat().st_mtime, reverse=True)
        return str(best_files[0])

    # Otherwise return the most recently modified .pth file
    pth_files.sort(key=lambda f: f.stat().st_mtime, reverse=True)
    return str(pth_files[0])


def pad_pil_to_ratio(pil_img: Image.Image) -> Image.Image:
    """Pad a grayscale PIL image so H and W are multiples of RATIO."""
    if pil_img.mode != "L":
        pil_img = pil_img.convert("L")

    w, h = pil_img.size
    if h == 0 or w == 0:
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
    aspect ratio."""
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
    """Convert a PIL image to a [1, 1, H, W] tensor and a dummy labels tensor.

    Steps:
        1. Convert to grayscale
        2. Normalize height to TARGET_H
        3. Pad H/W up to a multiple of RATIO
        4. Invert colours (whiteboard is black-on-white, CROHME is white-on-black)
        5. Convert to tensor and normalize to [0, 1]
        6. Create a dummy labels tensor (required by Inference.forward)
    """
    pil_img = normalize_height(pil_img)
    pil_img = pad_pil_to_ratio(pil_img)

    img_np = np.array(pil_img, dtype=np.float32)

    # Invert: whiteboard produces black-on-white, CROHME is white-on-black
    img_np = 255.0 - img_np
    img_np = img_np / 255.0

    # Convert to tensor: [H, W] -> [1, 1, H, W]
    img_tensor = torch.from_numpy(img_np).unsqueeze(0).unsqueeze(0)

    # Create dummy labels tensor (required by Inference.forward)
    # The labels are used for counting supervision; we pass a minimal valid label
    dummy_labels = torch.LongTensor([[1, 2]])  # [sos, eos]

    return img_tensor, dummy_labels


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
    if not Path(WORD_PATH).exists():
        logger.error(f"Vocabulary not found at {WORD_PATH}")
        yield
        return

    words = Words(WORD_PATH)
    params['word_num'] = len(words)
    params['words'] = words

    logger.info(f"Loaded vocabulary: {len(words)} symbols")

    # Find checkpoint
    checkpoints_dir = str(Path(__file__).resolve().parent / "CAN-main" / "checkpoints")
    checkpoint_path = find_best_checkpoint(checkpoints_dir)
    if not checkpoint_path:
        logger.error(f"No checkpoint found in {checkpoints_dir}")
        yield
        return

    logger.info(f"Loading checkpoint from {checkpoint_path} ...")

    try:
        model = Inference(params, draw_map=False)
        load_checkpoint(model, None, checkpoint_path)
    except Exception as exc:
        logger.exception("Failed to load model checkpoint")
        model = None
        yield
        return

    model.eval()
    model.to(device)
    logger.info("CAN model loaded successfully on %s.", device)
    yield


# ── App instance ─────────────────────────────────────────────────────────
app = FastAPI(title="CAN HWR API", version="1.0.0", lifespan=lifespan)

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
        img_tensor, dummy_labels = preprocess_image(pil_img)
    except Exception as exc:
        logger.exception("Failed to preprocess image")
        raise HTTPException(status_code=500, detail=f"Preprocessing failed: {exc}") from exc

    img_tensor = img_tensor.to(device)
    dummy_labels = dummy_labels.to(device)

    start = time.time()
    try:
        with torch.no_grad():
            word_probs, word_alphas, mae, mse = model(img_tensor, dummy_labels, "inference", is_train=False)
    except Exception as exc:
        logger.exception("Model inference failed")
        raise HTTPException(status_code=500, detail=f"Inference failed: {exc}") from exc
    elapsed = time.time() - start

    # word_probs is a list of token indices (int tensors), one per decoder step
    # Filter out sos/eos control tokens (indices 2 and 3 in words_dict.txt)
    sos_id = 2
    eos_id = 3
    filtered_tokens = [w.item() for w in word_probs if w.item() not in (sos_id, eos_id)]
    latex_string = words.decode(filtered_tokens)

    logger.info(f"Recognized in {elapsed:.2f}s: {latex_string!r}")

    return {
        "candidates": [{"latex": latex_string, "score": 1.0, "log_prob": 0.0}],
        "top": {"latex": latex_string, "score": 1.0, "log_prob": 0.0}
    }


if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8002, reload=False)