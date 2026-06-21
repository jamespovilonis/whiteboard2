"""End-to-end verification: run test images through server.preprocess_image + model."""
import sys, math
from pathlib import Path
import torch
from PIL import Image

SAN_DIR = str(Path(__file__).resolve().parent)
sys.path.insert(0, SAN_DIR)

print(">>> importing diag_preprocess helpers", flush=True)
import importlib.util
spec = importlib.util.spec_from_file_location("diag", str(Path(SAN_DIR) / "diag_preprocess.py"))
diag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diag)

print(">>> importing server.preprocess_image / convert_tree_to_latex", flush=True)
from server import preprocess_image, convert_tree_to_latex

print(">>> loading model on cpu (this can take a few seconds)...", flush=True)
model, params = diag.load_model("cpu")
print(">>> model loaded OK", flush=True)

repo_root = Path(SAN_DIR).parents[2]
images = ["test_image.png", "test_image2.png", "test_image3.png"]
print(f">>> beginning recognition loop over {len(images)} images", flush=True)
for img in images:
    p = str(repo_root / img)
    print(f"  - opening {img}", flush=True)
    pil = Image.open(p)
    t, m = preprocess_image(pil)
    print(f"    tensor={tuple(t.shape)}, running inference...", flush=True)
    with torch.no_grad():
        tree, mlp = model(t.to(params["device"]), m.to(params["device"]))
    latex = " ".join(convert_tree_to_latex(1, tree))
    conf = round(math.exp(mlp), 4) if mlp > float("-inf") else 0.0
    print(f"    conf={conf:.4f} latex={latex!r}", flush=True)

