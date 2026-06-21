"""
Diagnostic: determine which preprocessing the SAN checkpoint expects.

Runs a 2x2 matrix on each test image:
    scale:    fixed 320x1600 canvas  vs  natural size (padded to mult of 16)
    polarity: invert (255 - x)       vs  no invert
Plus cpu vs mps.

For each cell it prints the predicted LaTeX, the mean-log-prob confidence,
and the first ~15 raw tree tokens so we can see *what* the model is emitting
even when the LaTeX looks like gibberish.

Run from the SAN-main dir with the venv active:
    python3 diag_preprocess.py
"""

import sys
import math
from pathlib import Path

import numpy as np
import torch
import yaml
from PIL import Image

SAN_DIR = str(Path(__file__).resolve().parent)
sys.path.insert(0, SAN_DIR)

from dataset import Words
from infer.Backbone import Backbone
from utils import load_checkpoint

CONFIG_PATH = str(Path(SAN_DIR) / "config.yaml")
CHECKPOINT_PATH = str(Path(SAN_DIR) / "checkpoints" / "SAN_decoder" / "best.pth")
RATIO = 16

# Test images shipped with the repo (BOW polarity: ink~0, bg~255)
REPO_ROOT = Path(SAN_DIR).parents[2]
TEST_IMAGES = [
    str(REPO_ROOT / "test_image.png"),
    str(REPO_ROOT / "test_image2.png"),
    str(REPO_ROOT / "test_image3.png"),
]


def convert_tree_to_latex(nodeid, gtd_list):
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


def load_model(device):
    with open(CONFIG_PATH, 'r') as f:
        params = yaml.load(f, Loader=yaml.FullLoader)
    params['device'] = torch.device(device)
    params['checkpoint'] = CHECKPOINT_PATH
    words = Words(params['word_path'])
    params['word_num'] = len(words)
    params['struct_num'] = 7
    params['words'] = words
    model = Backbone(params=params)
    load_checkpoint(model, None, CHECKPOINT_PATH)
    model.eval()
    model.to(params['device'])
    return model, params


def to_tensor(img_np):
    t = torch.from_numpy(img_np).unsqueeze(0).unsqueeze(0)
    mask = torch.ones_like(t)
    return t, mask


def prep_fixed_canvas(pil_img, invert):
    """Server's current approach: resize to 320x1600, right-pad with white."""
    if pil_img.mode != "L":
        pil_img = pil_img.convert("L")
    TARGET_H, TARGET_W = 320, 1600
    w, h = pil_img.size
    scale = TARGET_H / max(h, 1)
    new_w = min(int(round(w * scale)), TARGET_W)
    new_w = max(new_w, 1)
    resized = pil_img.resize((new_w, TARGET_H), Image.Resampling.LANCZOS)
    canvas = Image.new("L", (TARGET_W, TARGET_H), 255)
    canvas.paste(resized, (0, 0))
    img_np = np.array(canvas, dtype=np.float32)
    if invert:
        img_np = 255.0 - img_np
    img_np /= 255.0
    return to_tensor(img_np)


def prep_natural(pil_img, invert):
    """Reference inference.py approach: natural size, no resize.
    Pad H/W up to a multiple of RATIO (=16) so the DenseNet feature map
    aligns with the downsampled mask.  Pad with the background value so
    the all-ones mask (matching inference.py) stays valid.
    """
    if pil_img.mode != "L":
        pil_img = pil_img.convert("L")
    img_np = np.array(pil_img, dtype=np.float32)
    if invert:
        img_np = 255.0 - img_np
    img_np /= 255.0
    # background value after normalization:
    #   no-invert -> white bg = 1.0 ; invert -> white bg becomes 0.0
    bg = 0.0 if invert else 1.0
    h, w = img_np.shape
    ph = (RATIO - h % RATIO) % RATIO
    pw = (RATIO - w % RATIO) % RATIO
    if ph or pw:
        img_np = np.pad(img_np, ((0, ph), (0, pw)), mode="constant", constant_values=bg)
    return to_tensor(img_np)


def run_cell(model, tensor, mask, device):
    tensor = tensor.to(device)
    mask = mask.to(device)
    with torch.no_grad():
        tree, mlp = model(tensor, mask)
    latex_list = convert_tree_to_latex(1, tree)
    latex = " ".join(latex_list)
    conf = round(math.exp(mlp), 4) if mlp > float("-inf") else 0.0
    token_preview = [t[0] for t in tree[:15]]
    return latex, conf, token_preview, len(tree)


def main():
    variants = [
        ("fixed320+invert", lambda p: prep_fixed_canvas(p, True)),
        ("fixed320+noinvert", lambda p: prep_fixed_canvas(p, False)),
        ("natural+invert", lambda p: prep_natural(p, True)),
        ("natural+noinvert", lambda p: prep_natural(p, False)),
    ]

    devices = []
    for d in ["cpu", "mps"]:
        if d == "mps" and not torch.backends.mps.is_available():
            print(f"[skip] {d} not available")
            continue
        devices.append(d)

    for dev in devices:
        print(f"\n========== device: {dev} ==========")
        try:
            model, params = load_model(dev)
        except Exception as e:
            print(f"  FAILED to load model on {dev}: {e}")
            continue

        for img_path in TEST_IMAGES:
            print(f"\n----- image: {Path(img_path).name} -----")
            try:
                pil = Image.open(img_path)
            except Exception as e:
                print(f"  cannot open: {e}")
                continue
            print(f"  source size: {pil.size}, mode: {pil.mode}")
            for name, fn in variants:
                try:
                    t, m = fn(pil)
                    latex, conf, toks, ntok = run_cell(model, t, m, params['device'])
                    print(f"  [{name}] conf={conf:.4f} ntok={ntok}")
                    print(f"      tokens[:15]: {toks}")
                    print(f"      latex: {latex!r}")
                except Exception as e:
                    print(f"  [{name}] ERROR: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()