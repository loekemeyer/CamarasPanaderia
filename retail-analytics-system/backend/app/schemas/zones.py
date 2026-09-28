from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Point = list[float]


def _validate_polygon(poly: list[Point]) -> list[Point]:
    if len(poly) < 3:
        raise ValueError("el polígono necesita al menos 3 puntos")
    for p in poly:
        if len(p) != 2:
            raise ValueError("cada punto debe ser [x, y]")
        if not all(0.0 <= v <= 1.0 for v in p):
            raise ValueError("las coordenadas deben estar normalizadas entre 0 y 1")
    return poly


class ZoneBase(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    kind: Literal["queue", "area"]
    polygon: list[Point]
    capacity: int | None = Field(default=None, ge=1)
    active: bool = True

    @field_validator("polygon")
    @classmethod
    def check_polygon(cls, v: list[Point]) -> list[Point]:
        return _validate_polygon(v)


class ZoneCreate(ZoneBase):
    camera_id: str | None = None


class ZoneUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    kind: Literal["queue", "area"] | None = None
    polygon: list[Point] | None = None
    capacity: int | None = Field(default=None, ge=1)
    active: bool | None = None

    @field_validator("polygon")
    @classmethod
    def check_polygon(cls, v: list[Point] | None) -> list[Point] | None:
        return None if v is None else _validate_polygon(v)


class ZoneOut(ZoneBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    camera_id: str
    created_at: datetime
    updated_at: datetime
