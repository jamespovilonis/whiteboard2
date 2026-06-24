import importlib.util
from pathlib import Path
import unittest

import numpy as np


MODULE_PATH = Path(__file__).resolve().parents[1] / "CanvasSegmentation" / "DBNet_Integration.py"
SPEC = importlib.util.spec_from_file_location("dbnet_integration", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DBNetNormalizationTests(unittest.TestCase):
    def test_normalizes_numpy_payload(self):
        raw = {
            "dt_polys": np.array([[[1, 2], [11, 2], [11, 8], [1, 8]]]),
            "dt_scores": np.array([0.875]),
        }
        detections = MODULE.normalize_detection_results([raw])
        self.assertEqual(len(detections), 1)
        self.assertEqual(
            detections[0]["bbox"],
            {"xMin": 1.0, "yMin": 2.0, "xMax": 11.0, "yMax": 8.0},
        )
        self.assertEqual(detections[0]["score"], 0.875)

    def test_skips_invalid_polygons(self):
        raw = {"dt_polys": [[[1, 2], [3, 4]]], "dt_scores": [1.0]}
        self.assertEqual(MODULE.normalize_detection_results([raw]), [])


if __name__ == "__main__":
    unittest.main()
