"""
CoMER Handwriting Recognition API Server

A FastAPI server that loads the CoMER model and exposes a /recognize endpoint.
Accepts a PNG image of handwritten math and returns recognized LaTeX.
"""

import io
import logging
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Tuple

import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from torchvision.transforms import ToTensor

# ── Constants ──────────────────────────────────────────────────────────
MAX_UPLOAD_SIZE_MB = 10
MAX_UPLOAD_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024

# ── Path setup: add CoMER source to sys.path ──────────────────────────
COMER_DIR = str(Path(__file__).resolve().parent)
sys.path.insert(0, COMER_DIR)

from comer.datamodule.vocab import vocab
from comer.lit_comer import LitCoMER
from comer.datamodule.transforms import ScaleToLimitRange

# ── Logging ───────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# ── Model globals ─────────────────────────────────────────────────────
model: LitCoMER = None
device = torch.device(
    "cuda" if torch.cuda.is_available()
    else "mps" if torch.backends.mps.is_available()
    else "cpu"
)

scale_transform = ScaleToLimitRange(w_lo=16, w_hi=1024, h_lo=16, h_hi=256)
to_tensor = ToTensor()


# ── Helpers ───────────────────────────────────────────────────────────

def preprocess_image(pil_img: Image.Image) -> Tuple[torch.Tensor, torch.Tensor]:
    """Convert a PIL image to a [1, 1, H, W] tensor and a [1, H, W] mask.

    Steps:
        1. Convert to grayscale
        2. Invert colours: whiteboard is black-on-white, CoMER expects white-on-black
        3. Scale to the size range expected by CoMER (matching CROHME dataset)
        4. Convert to tensor and add a batch dimension
        5. Create a zero mask (all pixels are valid)
    """
    # Grayscale
    if pil_img.mode != "L":
        pil_img = pil_img.convert("L")

    img_np = np.array(pil_img, dtype=np.uint8)

    # Invert colours: the CROHME dataset has white-on-black,
    # but our whiteboard has black-on-white. CoMER was trained on
    # white-on-black (foreground = white pixels), so we invert.
    img_np = 255 - img_np

    # Scale to valid size range
    try:
        img_np = scale_transform(img_np)
    except AssertionError as exc:
        raise ValueError(f"Image dimensions are outside the supported range: {exc}") from exc

    # ToTensor: [0,255] uint8 -> [0,1] float32, shape [1, H, W]
    img_tensor = to_tensor(img_np)

    # Pad to at least 16x16 (CoMER expects minimum size)
    _, h, w = img_tensor.shape
    if h < 16 or w < 16:
        pad_h = max(0, 16 - h)
        pad_w = max(0, 16 - w)
        img_tensor = torch.nn.functional.pad(img_tensor, (0, pad_w, 0, pad_h))
        _, h, w = img_tensor.shape

    # Mask: False = valid pixel, True = padding (none here)
    mask = torch.zeros((h, w), dtype=torch.bool)

    # Add batch dimension
    return img_tensor.unsqueeze(0), mask.unsqueeze(0)


# ── Lifespan ─────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: load model. Shutdown: cleanup (if needed)."""
    global model
    ckpt_path = Path(__file__).resolve().parent / "model_weights"
    if not ckpt_path.exists():
        logger.error(
            f"Checkpoint not found at {ckpt_path}. "
            "Please ensure models/model_weights exists."
        )
        yield
        return

    logger.info(f"Loading checkpoint from {ckpt_path} ...")
    try:
        model = LitCoMER.load_from_checkpoint(
            str(ckpt_path),
            map_location=device,
            weights_only=False,
        )
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
app = FastAPI(title="CoMER HWR API", version="1.0.0", lifespan=lifespan)

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
        {"candidates": [...], "top": {"latex": "...", "score": ...}}
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
        img_tensor, mask = preprocess_image(pil_img)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Failed to preprocess image")
        raise HTTPException(status_code=500, detail=f"Preprocessing failed: {exc}") from exc

    img_tensor = img_tensor.to(device)
    mask = mask.to(device)

    start = time.time()
    try:
        with torch.no_grad():
            candidates = model.approximate_joint_search_topk(img_tensor, mask, k=20)
    except Exception as exc:
        logger.exception("Model inference failed")
        raise HTTPException(status_code=500, detail=f"Inference failed: {exc}") from exc
    elapsed = time.time() - start

    # Build candidate list from top-k results (batch_size=1, so index 0).
    # Deduplicate by LaTeX string — the bidirectional beam search often
    # produces the same sequence via different beam paths. Keep only the
    # best score for each unique LaTeX.
    cand_list = []
    seen = set()
    for hyp in candidates[0]:
        latex = vocab.indices2label(hyp.seq)
        if latex in seen:
            continue
        seen.add(latex)
        cand_list.append({
            "latex": latex,
            "score": round(hyp.score, 4),
        })
        if len(cand_list) >= 10:
            break

    top_latex = cand_list[0]["latex"] if cand_list else ""
    logger.info(f"Recognized in {elapsed:.2f}s: {top_latex!r} (top-{len(cand_list)} unique)")

    return {"candidates": cand_list, "top": cand_list[0] if cand_list else None}


if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)