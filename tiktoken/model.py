from __future__ import annotations

from .core import Encoding
from .registry import get_encoding
import json

try:
    import importlib.resources as pkg_resources
except ImportError:
    # Try backported to PY<37 `importlib_resources`.
    import importlib_resources as pkg_resources

# TODO: these will likely be replaced by an API endpoint
MODEL_PREFIX_TO_ENCODING: dict[str, str] = {
    # chat
    "gpt-4-": "cl100k_base",  # e.g., gpt-4-0314, etc., plus gpt-4-32k
    "gpt-3.5-turbo-": "cl100k_base",  # e.g, gpt-3.5-turbo-0301, -0401, etc.
}

MODEL_TO_ENCODING: dict[str, str] = json.loads(pkg_resources.read_text("tiktoken", "model_to_encoding.json"))


def encoding_for_model(model_name: str) -> Encoding:
    """Returns the encoding used by a model."""
    encoding_name = None
    if model_name in MODEL_TO_ENCODING:
        encoding_name = MODEL_TO_ENCODING[model_name]
    else:
        # Check if the model matches a known prefix
        # Prefix matching avoids needing library updates for every model version release
        # Note that this can match on non-existent models (e.g., gpt-3.5-turbo-FAKE)
        for model_prefix, model_encoding_name in MODEL_PREFIX_TO_ENCODING.items():
            if model_name.startswith(model_prefix):
                return get_encoding(model_encoding_name)

    if encoding_name is None:
        raise KeyError(
            f"Could not automatically map {model_name} to a tokeniser. "
            "Please use `tiktok.get_encoding` to explicitly get the tokeniser you expect."
        ) from None

    return get_encoding(encoding_name)
