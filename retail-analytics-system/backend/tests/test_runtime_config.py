import pytest

from app.services.runtime_config import MASK, mask_source, unmask_source


def test_mask_hides_password_only():
    assert mask_source("rtsp://admin:Cl@ve1@10.0.0.5:554/x") == f"rtsp://admin:{MASK}@10.0.0.5:554/x"
    assert mask_source("/data/videos/a.mp4") == "/data/videos/a.mp4"
    assert mask_source("rtsp://10.0.0.5/x") == "rtsp://10.0.0.5/x"


def test_unmask_keeps_stored_password_when_untouched():
    stored = "rtsp://admin:Clave123@10.0.0.5:554/x"
    edited = f"rtsp://admin:{MASK}@10.0.0.6:554/y"
    assert unmask_source(edited, stored) == "rtsp://admin:Clave123@10.0.0.6:554/y"


def test_unmask_passes_new_password_through():
    assert unmask_source("rtsp://u:nueva@h/x", "rtsp://u:vieja@h/x") == "rtsp://u:nueva@h/x"


def test_unmask_without_stored_credentials_fails():
    with pytest.raises(ValueError):
        unmask_source(f"rtsp://u:{MASK}@h/x", "/data/videos/a.mp4")
