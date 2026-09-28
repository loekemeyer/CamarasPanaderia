from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class AlertOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    camera_id: str
    created_at: datetime
    kind: str
    severity: str
    title: str
    message: str
    value: float | None
    acknowledged: bool
    acknowledged_at: datetime | None
