"""PaddleOCR DBNet text-line detection for whiteboard segmentation.

The module deliberately contains no FastAPI concerns.  It owns the optional
PaddleOCR dependency, model lifetime, and normalization of PaddleOCR's result
objects into a small JSON-friendly representation used by the browser.
"""

from __future__ import annotations

import logging
import os
from threading import Lock
from typing import Any, Dict, Iterable, List, Optional

import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)


def _as_mapping(result: Any) -> Dict[str, Any]:
    """Extract the payload from PaddleOCR 3.x result variants."""
    if isinstance(result, dict):
        payload = result
    else:
        payload = getattr(result, "json", None)
        if callable(payload):
            payload = payload()
        if not isinstance(payload, dict):
            payload = getattr(result, "res", None)
        if not isinstance(payload, dict):
            payload = getattr(result, "__dict__", {})

    # Some PaddleX result objects wrap the useful fields in ``res``.
    nested = payload.get("res") if isinstance(payload, dict) else None
    return nested if isinstance(nested, dict) else payload


def _normalize_polygon(raw_polygon: Any) -> Optional[List[List[float]]]:
    try:
        points = np.asarray(raw_polygon, dtype=float).reshape(-1, 2)
    except (TypeError, ValueError):
        return None
    if len(points) < 3 or not np.isfinite(points).all():
        return None
    return [[round(float(x), 3), round(float(y), 3)] for x, y in points]


def normalize_detection_results(results: Iterable[Any]) -> List[Dict[str, Any]]:
    """Normalize PaddleOCR detections to polygons, AABBs, and scores."""
    detections: List[Dict[str, Any]] = []
    for result in results:
        payload = _as_mapping(result)
        polygons = payload.get("dt_polys")
        if polygons is None:
            polygons = payload.get("polys")
        if polygons is None:
            polygons = payload.get("boxes")
        if polygons is None:
            polygons = []
        scores = payload.get("dt_scores")
        if scores is None:
            scores = payload.get("scores")
        if scores is None:
            scores = []

        for index, raw_polygon in enumerate(polygons):
            polygon = _normalize_polygon(raw_polygon)
            if polygon is None:
                continue
            xs = [point[0] for point in polygon]
            ys = [point[1] for point in polygon]
            try:
                score = float(scores[index]) if index < len(scores) else 1.0
            except (TypeError, ValueError):
                score = 1.0
            detections.append(
                {
                    "polygon": polygon,
                    "bbox": {
                        "xMin": min(xs),
                        "yMin": min(ys),
                        "xMax": max(xs),
                        "yMax": max(ys),
                    },
                    "score": round(score, 6),
                }
            )
    return detections


class DBNetDetector:
    """Lazy, process-wide wrapper around PaddleOCR's text detector."""

    def __init__(self) -> None:
        self.model: Any = None
        self.load_error: Optional[str] = None
        self.model_name = os.getenv("DBNET_MODEL_NAME", "PP-OCRv5_mobile_det")
        self.score_threshold = float(os.getenv("DBNET_SCORE_THRESHOLD", "0.25"))
        self._lock = Lock()

    @property
    def loaded(self) -> bool:
        return self.model is not None

    def load(self) -> bool:
        if self.model is not None:
            return True
        with self._lock:
            if self.model is not None:
                return True
            try:
                from paddleocr import TextDetection

                logger.info("Loading PaddleOCR DBNet detector %s ...", self.model_name)
                self.model = TextDetection(model_name=self.model_name)
                self.load_error = None
                logger.info("PaddleOCR DBNet detector loaded.")
            except Exception as exc:  # optional dependency/model download failure
                self.model = None
                self.load_error = str(exc)
                logger.warning("DBNet detector unavailable: %s", exc)
        return self.model is not None

    def predict(self, image: Image.Image) -> List[Dict[str, Any]]:
        if self.model is None and not self.load():
            raise RuntimeError(self.load_error or "DBNet detector is unavailable")

        rgb_image = image.convert("RGB")
        image_array = np.asarray(rgb_image)
        with self._lock:
            raw_results = self.model.predict(image_array, batch_size=1)
            detections = normalize_detection_results(raw_results)
        return [item for item in detections if item["score"] >= self.score_threshold]


dbnet_detector = DBNetDetector()
