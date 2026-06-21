"""
Test script for the SAN server's preprocessing pipeline.

Creates a small black-on-white synthetic math image, runs it through the
server's preprocess_image / normalize_height / pad_pil_to_ratio helpers,
and sanity-checks that the output tensor has the correct scale-normalized,
padded-to-16 shape and polarity.  This can be run without loading the
model, so it is useful for quick regression checks.

NOTE: SAN was trained on CROHME images at heights ~50-120px.  Browser-
rasterized images arrive at 2-4x that scale (devicePixelRatio on Retina),
so preprocessing normalizes the height to TARGET_H (96px) before padding
H/W up to a multiple of the DenseNet ratio (16).
"""

import sys
from pathlib import Path

# Add SAN source directory to path so imports match the server runtime
SAN_DIR = str(Path(__file__).resolve().parent)
sys.path.insert(0, SAN_DIR)

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from server import pad_pil_to_ratio, normalize_height, preprocess_image, RATIO, TARGET_H


def make_synthetic_image(width: int = 240, height: int = 60) -> Image.Image:
    """Draw a simple black-on-white image with a digit and an operator."""
    img = Image.new("L", (width, height), 255)
    draw = ImageDraw.Draw(img)

    # Try to use a basic font; fall back to the default if unavailable
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 32)
    except Exception:
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 32)
        except Exception:
            font = ImageFont.load_default()

    draw.text((20, 10), "2 + 2", fill=0, font=font)
    return img


def test_pad_and_tensor():
    small_img = make_synthetic_image(240, 60)

    # pad_pil_to_ratio must pad (not resize) up to a multiple of RATIO.
    padded = pad_pil_to_ratio(small_img)
    pw, ph = padded.size
    assert pw % RATIO == 0, f"Padded width {pw} is not a multiple of {RATIO}"
    assert ph % RATIO == 0, f"Padded height {ph} is not a multiple of {RATIO}"
    # No downscaling: padded dims must be >= source dims
    assert pw >= 240 and ph >= 60, f"Padding shrank the image: {padded.size}"

    # normalize_height must resize the height to TARGET_H, preserving aspect ratio.
    normed = normalize_height(small_img)
    nw, nh = normed.size
    assert nh == TARGET_H, f"normalize_height produced height {nh}, expected {TARGET_H}"
    # Aspect ratio preserved (within 1px rounding)
    assert abs(nw - 240 * TARGET_H / 60) <= 1, f"Aspect ratio not preserved: {normed.size}"

    # preprocess_image applies normalize_height then pad_pil_to_ratio, so the
    # tensor height should be TARGET_H rounded up to a multiple of RATIO.
    tensor, mask = preprocess_image(small_img)
    _, _, h, w = tensor.shape
    assert h == TARGET_H, f"Tensor height should be {TARGET_H}, got {h}"
    assert w % RATIO == 0 and h % RATIO == 0, (
        f"Tensor H/W must be multiples of {RATIO}, got ({h},{w})"
    )
    assert mask.shape == tensor.shape, f"Mask shape {mask.shape} != tensor shape {tensor.shape}"

    # After inversion the white background should be ~0 and ink should be ~1
    img_np = tensor.squeeze().numpy()
    assert img_np.min() < 0.1, "Background should be near 0 after inversion"
    assert img_np.max() > 0.9, "Ink should be near 1 after inversion"

    # A 3x-scaled image (simulating devicePixelRatio) must produce the SAME
    # tensor shape as the 1x image after normalize_height.
    big_img = make_synthetic_image(240 * 3, 60 * 3)
    big_tensor, _ = preprocess_image(big_img)
    assert big_tensor.shape == tensor.shape, (
        f"Scale invariance broken: 3x tensor {tuple(big_tensor.shape)} != 1x tensor {tuple(tensor.shape)}"
    )

    print(f"Preprocessing test passed: tensor shape {tuple(tensor.shape)}")


if __name__ == "__main__":
    test_pad_and_tensor()