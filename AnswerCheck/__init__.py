"""Lightweight answer checking for the whiteboard application."""

from .checker import check_answer, check_equivalence
from .questions import get_question

__all__ = ["check_answer", "check_equivalence", "get_question"]
