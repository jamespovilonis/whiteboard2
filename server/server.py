"""
Unified Handwriting Recognition API Server

Loads CoMER, SAN, and CAN models and exposes a single /recognize endpoint
with ?model=comer|san|can parameter to select which model to use.

Also exposes /health?model=all|comer|san|can for health checks.
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
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from torchvision.transforms import ToTensor

# ── Constants ──────────────────────────────────────────────────────────
MAX_UPLOAD_SIZE_MB = 10
MAX_UPLOAD_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024

# SAN-specific constants
SAN_CONFIG_PATH = str(Path(__file__).resolve().parent.parent / "HandwritingToLatex" / "models" / "SAN-main" / "config.yaml")
SAN_CHECKPOINT_PATH = str(Path(__file__).resolve().parent.parent / "HandwritingToLatex" / "models" / "SAN-main" / "checkpoints" / "SAN_decoder" / "best.pth")
SAN_DATA_DIR = str(Path(__file__).resolve().parent.parent / "HandwritingToLatex" / "models" / "SAN-main" / "data")

# CAN-specific constants
CAN_CONFIG_PATH = str(Path(__file__).resolve().parent.parent / "HandwritingToLatex" / "models" / "CAN-main" / "CAN-main" / "config.yaml")
CAN_WORD_PATH = str(Path(__file__).resolve().parent.parent / "HandwritingToLatex" / "models" / "CAN-main" / "CAN-main" / "datasets" / "CROHME" / "words_dict.txt")
CAN_CHECKPOINTS_DIR = str(Path(__file__).resolve().parent.parent / "HandwritingToLatex" / "models" / "CAN-main" / "CAN-main" / "checkpoints")

# ── Logging ───────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# ── Model globals ─────────────────────────────────────────────────────
models = {}  # {"comer": LitCoMER, "san": Backbone, "can": Inference}
device = torch.device(
    "cuda" if torch.cuda.is_available()
    else "mps" if torch.backends.mps.is_available()
    else "cpu"
)

# ── Configurable paths (easy to override for deployment) ───────────────
SERVER_URLS = {
    "comer": "http://localhost:8000",
    "san": "http://localhost:8001",
    "can": "http://localhost:8002"
}


# ═══════════════════════════════════════════════════════════════════
# CoMER model loading & inference
# ═══════════════════════════════════════════════════════════════════

_comer_model = None
_comer_scale_transform = None
_comer_vocab = None


def _load_comer():
    """Load the CoMER model."""
    global _comer_model, _comer_scale_transform, _comer_vocab

    # Monkey-patch torch.load: PyTorch 2.6 defaults weights_only=True,
    # which blocks Lightning's internal checkpoint globals. Force
    # weights_only=False for the duration of model loading.
    _original_torch_load = torch.load
    def _patched_torch_load(*args, **kwargs):
        kwargs["weights_only"] = False
        return _original_torch_load(*args, **kwargs)
    torch.load = _patched_torch_load

    try:
        from comer.datamodule.vocab import vocab as comer_vocab
        from comer.lit_comer import LitCoMER
        from comer.datamodule.transforms import ScaleToLimitRange

        ckpt_path = Path(__file__).resolve().parent / "model_weights"
        if not ckpt_path.exists():
            logger.error(f"CoMER checkpoint not found at {ckpt_path}. Skipping.")
            return

        logger.info("Loading CoMER checkpoint from %s ...", ckpt_path)
        try:
            _comer_model = LitCoMER.load_from_checkpoint(
                str(ckpt_path), map_location=device,
            )
        except Exception as exc:
            logger.exception("Failed to load CoMER checkpoint")
            return
    finally:
        torch.load = _original_torch_load

    _comer_scale_transform = ScaleToLimitRange(w_lo=16, w_hi=1024, h_lo=16, h_hi=256)
    _comer_vocab = comer_vocab
    _comer_model.eval()
    _comer_model.to(device)
    logger.info("CoMER model loaded successfully on %s.", device)


def _preprocess_comer(pil_img: Image.Image) -> Tuple[torch.Tensor, torch.Tensor]:
    if pil_img.mode != "L":
        pil_img = pil_img.convert("L")
    img_np = np.array(pil_img, dtype=np.uint8)
    img_np = 255 - img_np  # invert: white-on-black for CROHME format
    try:
        img_np = _comer_scale_transform(img_np)
    except AssertionError as exc:
        raise ValueError(f"Image dimensions outside supported range: {exc}") from exc
    to_tensor = ToTensor()
    img_tensor = to_tensor(img_np)
    _, h, w = img_tensor.shape
    if h < 16 or w < 16:
        pad_h = max(0, 16 - h)
        pad_w = max(0, 16 - w)
        img_tensor = torch.nn.functional.pad(img_tensor, (0, pad_w, 0, pad_h))
    mask = torch.zeros((img_tensor.shape[-2], img_tensor.shape[-1]), dtype=torch.bool)
    return img_tensor.unsqueeze(0), mask.unsqueeze(0)


def _inference_comer(img_tensor: torch.Tensor, mask: torch.Tensor):
    candidates = _comer_model.approximate_joint_search_topk(img_tensor, mask, k=20)
    cand_list = []
    seen = set()
    for hyp in candidates[0]:
        latex = _comer_vocab.indices2label(hyp.seq)
        if latex in seen:
            continue
        seen.add(latex)
        cand_list.append({"latex": latex, "score": round(float(hyp.score), 4)})
        if len(cand_list) >= 10:
            break
    return cand_list


# ═══════════════════════════════════════════════════════════════════
# SAN model loading & inference
# ═══════════════════════════════════════════════════════════════════

_san_model = None
_san_words = None
_RIO = 16
_TARGET_H_SAN = 96


def _load_san():
    """Load the SAN model."""
    global _san_model, _san_words
    san_dir = str(Path(__file__).resolve().parent.parent / "HandwritingToLatex" / "models" / "SAN-main")
    sys.path.insert(0, san_dir)
    try:
        from dataset import Words
        from infer.Backbone import Backbone
        from utils import load_checkpoint as san_load_checkpoint

        # Config & vocab
        with open(SAN_CONFIG_PATH, 'r') as f:
            san_params = yaml.load(f, Loader=yaml.FullLoader)
        san_params['device'] = device
        san_params['checkpoint'] = SAN_CHECKPOINT_PATH
        san_params['train_image_path'] = ''
        san_params['train_label_path'] = ''
        san_params['eval_image_path'] = ''
        san_params['eval_label_path'] = ''

        word_path = str(Path(san_dir) / "data" / "word.txt")
        if not Path(word_path).exists():
            logger.error(f"SAN vocabulary not found at {word_path}. Skipping.")
            return
        _san_words = Words(word_path)
        san_params['word_num'] = len(_san_words)
        san_params['struct_num'] = 7
        san_params['words'] = _san_words

        # Checkpoint
        if not Path(SAN_CHECKPOINT_PATH).exists():
            logger.error(f"SAN checkpoint not found at {SAN_CHECKPOINT_PATH}. Skipping.")
            return

        logger.info("Loading SAN checkpoint from %s ...", SAN_CHECKPOINT_PATH)
        _san_model = Backbone(params=san_params)
        san_load_checkpoint(_san_model, None, SAN_CHECKPOINT_PATH)
        _san_model.eval()
        _san_model.to(device)
        logger.info("SAN model loaded successfully on %s.", device)
    except Exception as exc:
        logger.exception("Failed to load SAN model")
    finally:
        sys.path.pop(0)
        # Clean up SAN modules from sys.modules so they don't shadow CAN imports
        for mod_name in list(sys.modules.keys()):
            if mod_name.startswith(("dataset", "utils", "infer", "models")):
                del sys.modules[mod_name]


def _pad_pil_to_ratio(pil_img: Image.Image, ratio: int = _RIO) -> Image.Image:
    if pil_img.mode != "L":
        pil_img = pil_img.convert("L")
    w, h = pil_img.size
    if h == 0 or w == 0:
        return Image.new("L", (ratio, ratio), 255)
    ph = (ratio - h % ratio) % ratio
    pw = (ratio - w % ratio) % ratio
    if ph == 0 and pw == 0:
        return pil_img
    canvas = Image.new("L", (w + pw, h + ph), 255)
    canvas.paste(pil_img, (0, 0))
    return canvas


def _normalize_height_san(pil_img: Image.Image, target_h: int = _TARGET_H_SAN) -> Image.Image:
    if pil_img.mode != "L":
        pil_img = pil_img.convert("L")
    w, h = pil_img.size
    if h == 0 or w == 0:
        return Image.new("L", (_RIO, _RIO), 255)
    if h == target_h:
        return pil_img
    scale = target_h / h
    new_w = max(int(round(w * scale)), 1)
    return pil_img.resize((new_w, target_h), Image.Resampling.LANCZOS)


def _preprocess_san(pil_img: Image.Image) -> Tuple[torch.Tensor, torch.Tensor]:
    img = _normalize_height_san(pil_img)
    img = _pad_pil_to_ratio(img)
    img_np = np.array(img, dtype=np.float32)
    # First invert (black-on-white → white-on-black), then normalize to [0,1]
    img_np = (255.0 - img_np) / 255.0
    img_tensor = torch.from_numpy(img_np).unsqueeze(0).unsqueeze(0)
    _, _, h, w = img_tensor.shape
    mask = torch.ones((1, 1, h, w), dtype=torch.float32)
    return img_tensor, mask


def _convert_tree_to_latex(nodeid: int, gtd_list: list):
    """Convert SAN tree-format prediction to LaTeX string."""
    isparent = False
    child_list = []
    for i in range(len(gtd_list)):
        if gtd_list[i][2] == nodeid:
            isparent = True
            child_list.append([gtd_list[i][0], gtd_list[i][1], gtd_list[i][3]])
    if not isparent:
        return [gtd_list[nodeid][0]]
    if gtd_list[nodeid][0] == '\\frac':
        return_string = [gtd_list[nodeid][0]]
        for i in range(len(child_list)):
            if child_list[i][2] == 'Above':
                return_string += ['{'] + _convert_tree_to_latex(child_list[i][1], gtd_list) + ['}']
        for i in range(len(child_list)):
            if child_list[i][2] == 'Below':
                return_string += ['{'] + _convert_tree_to_latex(child_list[i][1], gtd_list) + ['}']
        for i in range(len(child_list)):
            if child_list[i][2] == 'Right':
                return_string += _convert_tree_to_latex(child_list[i][1], gtd_list)
        for i in range(len(child_list)):
            if child_list[i][2] not in ['Right', 'Above', 'Below']:
                return_string += ['illegal']
    else:
        return_string = [gtd_list[nodeid][0]]
        for i in range(len(child_list)):
            if child_list[i][2] in ['l_sup']:
                return_string += ['['] + _convert_tree_to_latex(child_list[i][1], gtd_list) + [']']
        for i in range(len(child_list)):
            if child_list[i][2] == 'Inside':
                return_string += ['{'] + _convert_tree_to_latex(child_list[i][1], gtd_list) + ['}']
        for i in range(len(child_list)):
            if child_list[i][2] in ['Sub', 'Below']:
                return_string += ['_', '{'] + _convert_tree_to_latex(child_list[i][1], gtd_list) + ['}']
        for i in range(len(child_list)):
            if child_list[i][2] in ['Sup', 'Above']:
                return_string += ['^', '{'] + _convert_tree_to_latex(child_list[i][1], gtd_list) + ['}']
        for i in range(len(child_list)):
            if child_list[i][2] in ['Right']:
                return_string += _convert_tree_to_latex(child_list[i][1], gtd_list)
    return return_string


def _inference_san(img_tensor: torch.Tensor, mask: torch.Tensor):
    tree_result, mean_log_prob = _san_model(img_tensor, mask)
    latex_list = _convert_tree_to_latex(1, tree_result)
    latex_string = ' '.join(latex_list)
    confidence = round(float(math.exp(mean_log_prob)), 4) if mean_log_prob > float('-inf') else 0.0
    return [{"latex": latex_string, "score": confidence, "log_prob": round(float(mean_log_prob), 4)}]


# ═══════════════════════════════════════════════════════════════════
# CAN model loading & inference
# ═══════════════════════════════════════════════════════════════════

_can_model = None
_can_words = None


def _load_can():
    """Load the CAN model."""
    global _can_model, _can_words
    can_dir = str(Path(__file__).resolve().parent.parent / "HandwritingToLatex" / "models" / "CAN-main")
    can_main_dir = str(Path(can_dir) / "CAN-main")

    # Add the CAN-main top-level directory to sys.path so dataset.py and utils.py are importable.
    sys.path.insert(0, can_main_dir)
    try:
        # Load models/ submodules via importlib to bypass models/__init__.py,
        # which would otherwise trigger a chain of imports (decoder → counting_utils
        # → matplotlib) that are not needed for inference.
        import importlib.util as _ilutil

        def _load_module_direct(name, relpath):
            """Load a .py file as a module, bypassing package __init__.py."""
            spec = _ilutil.spec_from_file_location(name, str(Path(can_main_dir) / relpath))
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

        _load_module_direct("models.densenet", "models/densenet.py")
        _load_module_direct("models.attention", "models/attention.py")
        _load_module_direct("models.decoder", "models/decoder.py")
        _load_module_direct("models.counting", "models/counting.py")

        # Now load infer_model — its "from models.xxx import ..." will find the
        # pre-loaded modules in sys.modules and skip models/__init__.py.
        _infer_mod = _load_module_direct("models.infer_model", "models/infer_model.py")
        Inference = _infer_mod.Inference

        from dataset import Words
        from utils import load_checkpoint as can_load_checkpoint

        with open(CAN_CONFIG_PATH, 'r') as f:
            can_params = yaml.load(f, Loader=yaml.FullLoader)
        can_params['device'] = device
        can_params['word_path'] = CAN_WORD_PATH
        can_params['train_image_path'] = ''
        can_params['train_label_path'] = ''
        can_params['eval_image_path'] = ''
        can_params['eval_label_path'] = ''

        if not Path(CAN_WORD_PATH).exists():
            logger.error(f"CAN vocabulary not found at {CAN_WORD_PATH}. Skipping.")
            return
        _can_words = Words(CAN_WORD_PATH)
        can_params['word_num'] = len(_can_words)
        can_params['words'] = _can_words

        # Find best checkpoint
        checkpoints_path = Path(CAN_CHECKPOINTS_DIR)
        if not checkpoints_path.exists():
            logger.error(f"CAN checkpoints directory not found at {CAN_CHECKPOINTS_DIR}. Skipping.")
            return
        pth_files = list(checkpoints_path.rglob("*.pth"))
        if not pth_files:
            logger.error(f"No .pth checkpoint files found in {CAN_CHECKPOINTS_DIR}. Skipping.")
            return
        best_files = [f for f in pth_files if 'best' in f.name.lower()]
        if best_files:
            best_files.sort(key=lambda f: f.stat().st_mtime, reverse=True)
            checkpoint_path = str(best_files[0])
        else:
            pth_files.sort(key=lambda f: f.stat().st_mtime, reverse=True)
            checkpoint_path = str(pth_files[0])

        logger.info("Loading CAN checkpoint from %s ...", checkpoint_path)
        _can_model = Inference(can_params, draw_map=False)
        can_load_checkpoint(_can_model, None, checkpoint_path)
        _can_model.eval()
        _can_model.to(device)
        logger.info("CAN model loaded successfully on %s.", device)
    except Exception as exc:
        logger.exception("Failed to load CAN model")
    finally:
        sys.path.pop(0)


def _normalize_height_can(pil_img: Image.Image, target_h: int = 96) -> Image.Image:
    if pil_img.mode != "L":
        pil_img = pil_img.convert("L")
    w, h = pil_img.size
    if h == 0 or w == 0:
        return Image.new("L", (_RIO, _RIO), 255)
    if h == target_h:
        return pil_img
    scale = target_h / h
    new_w = max(int(round(w * scale)), 1)
    return pil_img.resize((new_w, target_h), Image.Resampling.LANCZOS)


def _pad_pil_to_ratio_can(pil_img: Image.Image, ratio: int = _RIO) -> Image.Image:
    if pil_img.mode != "L":
        pil_img = pil_img.convert("L")
    w, h = pil_img.size
    if h == 0 or w == 0:
        return Image.new("L", (ratio, ratio), 255)
    ph = (ratio - h % ratio) % ratio
    pw = (ratio - w % ratio) % ratio
    if ph == 0 and pw == 0:
        return pil_img
    canvas = Image.new("L", (w + pw, h + ph), 255)
    canvas.paste(pil_img, (0, 0))
    return canvas


def _preprocess_can(pil_img: Image.Image) -> Tuple[torch.Tensor, torch.Tensor]:
    img = _normalize_height_can(pil_img)
    img = _pad_pil_to_ratio_can(img)
    img_np = np.array(img, dtype=np.float32)
    # First invert (black-on-white → white-on-black), then normalize to [0,1]
    img_np = (255.0 - img_np) / 255.0
    img_tensor = torch.from_numpy(img_np).unsqueeze(0).unsqueeze(0)
    dummy_labels = torch.LongTensor([[1, 2]])  # [sos, eos]
    return img_tensor, dummy_labels


def _inference_can(img_tensor: torch.Tensor, dummy_labels: torch.Tensor):
    word_probs, _, _, _ = _can_model(img_tensor, dummy_labels, "inference", is_train=False)
    sos_id, eos_id = 2, 3
    filtered_tokens = [w.item() for w in word_probs if w.item() not in (sos_id, eos_id)]
    latex_string = _can_words.decode(filtered_tokens)
    return [{"latex": latex_string, "score": 1.0, "log_prob": 0.0}]


# ═══════════════════════════════════════════════════════════════════
# Unified response normalization (all models → same format)
# ═══════════════════════════════════════════════════════════════════

def _normalize_confidence(raw_candidates):
    """Normalize candidate scores across models into a unified [0,1] confidence.

    For COMER (beam search): convert log-probs to softmax probabilities over
    displayed candidates; use the top candidate's relative probability as confidence.
    For SAN: score is already a per-step confidence in [0,1].
    For CAN: score=1.0 (greedy decode with no per-step confidence).
    """
    if not raw_candidates or len(raw_candidates) == 0:
        return []

    scores = [c["score"] for c in raw_candidates if "score" in c]
    if len(scores) == 0:
        for c in raw_candidates:
            c["confidence"] = 0.0
        return raw_candidates

    max_score = max(scores)
    # If all scores are identical (e.g., all 1.0), no normalization needed
    if len(set(round(s, 6) for s in scores)) == 1:
        for c in raw_candidates:
            c["confidence"] = 1.0 / max(len(raw_candidates), 1)
        return raw_candidates

    # Softmax over log-probs (CoFER style)
    exps = [math.exp(s - max_score) for s in scores]
    sum_exps = sum(exps)
    if sum_exps <= 0:
        for i, c in enumerate(raw_candidates):
            c["confidence"] = 1.0 / len(raw_candidates)
    else:
        for i, c in enumerate(raw_candidates):
            c["confidence"] = exps[i] / sum_exps

    return raw_candidates


# ═══════════════════════════════════════════════════════════════════
# Lifespan (load all models)
# ═══════════════════════════════════════════════════════════════════

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Loading all handwriting recognition models...")
    _load_comer()
    _load_san()
    _load_can()

    loaded = [name for name, m in [("comer", _comer_model), ("san", _san_model), ("can", _can_model)] if m is not None]
    logger.info("Models ready: %s. Device: %s", ", ".join(loaded) or "(none)", device)

    yield


# ═══════════════════════════════════════════════════════════════════
# App instance
# ═══════════════════════════════════════════════════════════════════

app = FastAPI(title="Unified HWR API (CoMER/SAN/CAN)", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Endpoints ───────────────────────────────────────────────────────────

VALID_MODELS = {"comer", "san", "can"}


@app.get("/health")
def health(model: str = Query("all")):
    if model == "all":
        return {
            "status": "ok",
            "models": {
                "comer": _comer_model is not None,
                "san": _san_model is not None,
                "can": _can_model is not None,
            }
        }
    if model not in VALID_MODELS:
        raise HTTPException(400, f"Invalid model: {model}. Choose from {VALID_MODELS}")
    status = {"status": "ok", "model": model, "loaded": False}
    if model == "comer":
        status["loaded"] = _comer_model is not None
    elif model == "san":
        status["loaded"] = _san_model is not None
    elif model == "can":
        status["loaded"] = _can_model is not None
    return status


@app.post("/recognize")
async def recognize(
    file: UploadFile = File(...),
    model: str = Query("comer"),
):
    """Recognize handwritten math from an uploaded PNG image.

    Args:
        file: PNG image of handwritten math.
        model: Which model to use — 'comer', 'san', or 'can'.

    Returns unified format:
        {"candidates": [{latex, score, confidence}], "top": {latex, score, confidence}}
    """
    if model not in VALID_MODELS:
        raise HTTPException(400, f"Invalid model: {model}. Choose from {VALID_MODELS}")

    # Read with size limit
    try:
        contents = await file.read()
        if not contents:
            raise HTTPException(status_code=400, detail="Empty image file.")
        if len(contents) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"Image too large. Maximum size is {MAX_UPLOAD_SIZE_MB} MB.")
        pil_img = Image.open(io.BytesIO(contents))
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to read uploaded image")
        raise HTTPException(status_code=400, detail=f"Could not read image: {exc}") from exc

    # Dispatch to selected model
    start = time.time()
    try:
        if model == "comer":
            if _comer_model is None:
                raise HTTPException(503, "CoMER model is not loaded.")
            img_tensor, mask = _preprocess_comer(pil_img)
            raw_candidates = _inference_comer(img_tensor.to(device), mask.to(device))
        elif model == "san":
            if _san_model is None:
                raise HTTPException(503, "SAN model is not loaded.")
            img_tensor, san_mask = _preprocess_san(pil_img)
            raw_candidates = _inference_san(img_tensor.to(device), san_mask.to(device))
        elif model == "can":
            if _can_model is None:
                raise HTTPException(503, "CAN model is not loaded.")
            img_tensor, dummy_labels = _preprocess_can(pil_img)
            raw_candidates = _inference_can(img_tensor.to(device), dummy_labels.to(device))
        else:
            raise HTTPException(400, f"Unknown model: {model}")
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Model inference failed")
        raise HTTPException(status_code=500, detail=f"Inference failed: {exc}") from exc

    elapsed = time.time() - start

    # Normalize confidence scores
    candidates = _normalize_confidence(raw_candidates)
    top = candidates[0] if candidates else None

    latex_str = top["latex"] if top else ""
    logger.info("[%s] Recognized in %.2fs: %r", model, elapsed, latex_str)

    return {"candidates": candidates, "top": top}


if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
