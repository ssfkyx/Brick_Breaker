#!/usr/bin/env python3
"""Brick Breaker -- 单文件弹球游戏（架构与状态图/ERD 见 docs/architecture.md）。

Requirements
    Python 3.8+ and Pygame 2.x:
        python -m pip install pygame-ce      (or: pip install pygame)

Run
    python brick_breaker.py

Controls
    Left / Right arrow (or A / D)  move the paddle         移动挡板
    Space / Up / Enter             launch the ball         发射（球初始吸附在挡板上）
    P                              pause / resume          暂停
    R                              restart the run         重开
    M                              mute / unmute           静音
    T                              change instrument       切换音色（SINE/钢琴/吉他）
    F                              toggle fullscreen       全屏
    Q / Escape                     quit                    退出
    After a game over: R restarts, Q quits.

Module index -- every banner below maps 1:1 onto a module of docs/architecture.md:
    M1  CONFIG    tunables, palette, enums (RunState / BallState / BrickState / HitKind / Intent)
    M2  GEOMETRY  FieldLayout: the limited room, brick grid and derived sizes
    M3  MODEL     ERD entities: Brick, Paddle, Ball, RunStats, ScoreEntry, Record, Settings, Popup
    M4  PHYSICS   CollisionEngine: detection + response, emits CollisionEvent facts
    M5  RULES     ScoringRules: points, combos, bonuses, ball-speed policy (pure functions)
    M6  LEVELS    LevelFactory: level profile -> brick wall
    M7  AUDIO     SoundBank: procedurally synthesised effects, degrades to silence
    M8  VIEW      Renderer: background, brick fade, HUD, overlays (read-only on the model)
    M9  INPUT     InputController: SDL events -> Intent values + paddle axis
    M10 SESSION   GameSession: the run state machine (single owner of RunState)
    M11 APP       App: window, event dispatch, fixed-timestep loop (+ `Game` alias)

Design notes
    * Pure Pygame + Python standard library.  No OS-specific calls, no subprocesses, no asset
      files (sounds are synthesised at start-up, the bundled default font is used), so the same
      file runs unchanged on Windows 10/11 and on Linux, including WSL with WSLg.
    * Physics run on a fixed 120 Hz timestep with sub-stepping: identical behaviour on 60 Hz and
      144 Hz displays, and the ball cannot tunnel through bricks at high speed.
    * The paddle bounce uses the hit offset *and* the paddle's instantaneous velocity (english),
      so moving the paddle while it strikes the ball changes the outgoing angle.
    * A brick that is destroyed enters BrickState.FADING: it stops colliding immediately and
      fades out over BRICK_FADE_TIME, so it can never be scored twice.
    * All geometry derives from the current window size; the initial window is sized to fit the
      desktop.  Losing keyboard focus clears held keys and pauses, so the paddle cannot get
      stuck sliding in the background.
"""

from __future__ import annotations

import math
import random
import sys
from array import array
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Sequence, Tuple

import pygame

# ===========================================================================
# M1 CONFIG -- 常量与枚举
# ===========================================================================

WINDOW_WIDTH = 960
WINDOW_HEIGHT = 720

TARGET_FPS = 60
PHYSICS_STEP = 1.0 / 120.0          # fixed simulation step, in seconds
MAX_FRAME_TIME = 0.25               # clamp big hitches (window drag, debugger)
MAX_SUBSTEPS = 64                   # safety cap for the collision sub-stepper

BRICK_COLUMNS = 11
BRICK_ROWS_BASE = 6
BRICK_ROWS_MAX = 8

PADDLE_MAX_BOUNCE_DEG = 55.0        # steering from where the ball hits the paddle
PADDLE_SPIN_DEG = 22.0              # extra angle contributed by a moving paddle
PADDLE_SPIN_REF_SPEED = 900.0       # paddle speed that counts as "full english"
PADDLE_MAX_TOTAL_DEG = 70.0         # clamp for offset + english
MIN_HORIZONTAL_RATIO = 0.22         # stops the ball from bouncing straight up
PADDLE_RALLY_SPEEDUP = 0.012        # the rally gets slightly faster per paddle hit
MAX_RALLY_MULTIPLIER = 1.75

LEVEL_SPEED_GROWTH = 0.07           # ball speed gained per level
MAX_SPEED_FACTOR = 2.4

STARTING_LIVES = 3
COMBO_STEP = 4                      # bricks per combo multiplier step
COMBO_MAX = 5
LEVEL_BONUS_BASE = 250              # multiplied by the level number
LEVEL_CLEAR_DELAY = 1.6             # seconds before the next level auto-starts
BRICK_FADE_TIME = 0.30              # R7: fade-out duration of a destroyed brick
SCORE_LOG_LIMIT = 64                # SCORE_ENTRY ring size
POPUP_LIFE = 0.8
POPUP_RISE = 34.0

BRICK_TONES = 8                     # number of pre-rendered brick blip pitches

# Audio (M7): the game ships no audio files, so every instrument preset is
# synthesised from these settings at run time.
DEFAULT_INSTRUMENT = "SINE"         # preset selected on start-up (v1.0.0 sound)
AUDIO_TABLE_SIZE = 2048             # samples per wavetable cycle
AUDIO_TAIL_FADE = 0.012             # seconds of fade-out to avoid an end click

# Palette
COLOR_BG_TOP = (13, 15, 29)
COLOR_BG_BOTTOM = (30, 22, 50)
COLOR_PANEL = (18, 20, 38)
COLOR_TEXT = (238, 241, 252)
COLOR_TEXT_DIM = (146, 154, 180)
COLOR_ACCENT = (96, 206, 255)
COLOR_DANGER = (240, 84, 96)
COLOR_BALL = (250, 250, 255)
COLOR_PADDLE = (120, 220, 255)
COLOR_PADDLE_EDGE = (240, 252, 255)
COLOR_FLOOR_EDGE = (74, 34, 52)

# One colour per brick row, top row first (top rows are worth more).
BRICK_COLORS: List[Tuple[int, int, int]] = [
    (238, 92, 92),
    (245, 146, 78),
    (247, 205, 84),
    (128, 214, 122),
    (94, 176, 240),
    (170, 130, 240),
    (238, 122, 196),
    (150, 220, 220),
]


class RunState(Enum):
    """Session state machine (see docs/architecture.md section 2.1)."""
    READY = "ready"                 # ball attached to the paddle, waiting for launch
    PLAYING = "playing"
    PAUSED = "paused"
    LEVEL_CLEAR = "level_clear"
    GAME_OVER = "game_over"


class BallState(Enum):
    """Ball state machine (section 2.2)."""
    ATTACHED = "attached"
    IN_FLIGHT = "in_flight"
    LOST = "lost"


class BrickState(Enum):
    """Brick state machine (section 2.3)."""
    INTACT = "intact"
    CRACKED = "cracked"
    FADING = "fading"
    GONE = "gone"


class HitKind(Enum):
    """Kind of collision fact reported by M4."""
    WALL = "wall"
    PADDLE = "paddle"
    BRICK = "brick"
    FLOOR = "floor"


class Intent(Enum):
    """What M9 understands; M10 decides what it means in the current state."""
    PRIMARY = "primary"                 # space / up / enter
    TOGGLE_PAUSE = "toggle_pause"
    RESTART = "restart"
    QUIT = "quit"
    TOGGLE_MUTE = "toggle_mute"
    CYCLE_INSTRUMENT = "cycle_instrument"   # T: next procedural instrument timbre
    TOGGLE_FULLSCREEN = "toggle_fullscreen"
    RESIZE = "resize"
    FOCUS_LOST = "focus_lost"


# Backwards-compatible aliases for existing scripts / test harnesses.
STATE_READY = RunState.READY
STATE_PLAY = RunState.PLAYING
STATE_PAUSED = RunState.PAUSED
STATE_LEVEL_CLEAR = RunState.LEVEL_CLEAR
STATE_OVER = RunState.GAME_OVER

LEVEL_CLEAR_BONUS = LEVEL_BONUS_BASE            # older name
MAX_SPEED_MULTIPLIER = MAX_RALLY_MULTIPLIER     # older name
PADDLE_SPEEDUP_PER_HIT = PADDLE_RALLY_SPEEDUP   # older name


# ===========================================================================
# M2 GEOMETRY -- 有限房间几何
# ===========================================================================

def clamp(value: float, low: float, high: float) -> float:
    """Clamp *value* into the inclusive range [low, high]."""
    if value < low:
        return low
    if value > high:
        return high
    return value


def circle_rect_collision(
    cx: float, cy: float, radius: float, rect: pygame.Rect
) -> Optional[Tuple[float, float, float]]:
    """Circle versus axis-aligned rectangle test.

    Returns ``(normal_x, normal_y, penetration)`` when the circle overlaps the
    rectangle, otherwise ``None``.  The normal points from the rectangle towards
    the circle, i.e. along the direction the circle must be pushed to separate
    the two shapes.
    """
    closest_x = clamp(cx, rect.left, rect.right)
    closest_y = clamp(cy, rect.top, rect.bottom)
    dx = cx - closest_x
    dy = cy - closest_y
    dist_sq = dx * dx + dy * dy

    if dist_sq > radius * radius:
        return None

    if dist_sq > 1e-9:
        dist = math.sqrt(dist_sq)
        return dx / dist, dy / dist, radius - dist

    # Centre is inside the rectangle: push out along the shallowest face.
    left = cx - rect.left
    right = rect.right - cx
    top = cy - rect.top
    bottom = rect.bottom - cy
    smallest = min(left, right, top, bottom)
    if smallest == left:
        return -1.0, 0.0, left + radius
    if smallest == right:
        return 1.0, 0.0, right + radius
    if smallest == top:
        return 0.0, -1.0, top + radius
    return 0.0, 1.0, bottom + radius


@dataclass(frozen=True)
class FieldLayout:
    """The limited room (R1) plus the brick grid, derived from the window size.

    Immutable: whenever the window changes, M11 asks for a new instance and M10
    applies it (see ``GameSession.resize``).
    """
    width: int
    height: int
    rows: int
    hud_height: float
    top_wall: float
    brick_x0: float
    brick_y0: float
    brick_w: float
    brick_h: float
    brick_gap: float
    base_speed: float

    # -- construction ------------------------------------------------------
    @classmethod
    def compute(cls, width: int, height: int, rows: int) -> "FieldLayout":
        width = max(240, int(width))
        height = max(200, int(height))
        rows = max(1, int(rows))

        hud_height = max(40.0, height * 0.085)
        margin = width * 0.045
        gap = max(3.0, width * 0.006)
        brick_w = (width - 2.0 * margin - gap * (BRICK_COLUMNS - 1)) / BRICK_COLUMNS
        brick_h = clamp(brick_w * 0.42, 12.0, height * 0.045)
        return cls(
            width=width,
            height=height,
            rows=rows,
            hud_height=hud_height,
            top_wall=hud_height,
            brick_x0=margin,
            brick_y0=hud_height + height * 0.055,
            brick_w=brick_w,
            brick_h=brick_h,
            brick_gap=gap,
            base_speed=max(240.0, height * 0.62),
        )

    # -- derived entity sizes (ERD: PADDLE / BALL own these values) --------
    @property
    def paddle_width(self) -> float:
        return clamp(self.width * 0.155, 70.0, 180.0)

    @property
    def paddle_height(self) -> float:
        return clamp(self.height * 0.021, 10.0, 18.0)

    @property
    def paddle_bottom(self) -> float:
        return self.height - max(36.0, self.height * 0.075)

    @property
    def ball_radius(self) -> float:
        return clamp(self.width * 0.0105, 6.0, 11.0)

    # -- grid helpers ------------------------------------------------------
    def brick_rect(self, row: int, col: int) -> pygame.Rect:
        return pygame.Rect(
            int(round(self.brick_x0 + col * (self.brick_w + self.brick_gap))),
            int(round(self.brick_y0 + row * (self.brick_h + self.brick_gap))),
            max(1, int(round(self.brick_w))),
            max(1, int(round(self.brick_h))),
        )

    @property
    def room_rect(self) -> pygame.Rect:
        """The playable room: everything below the HUD."""
        return pygame.Rect(0, int(self.top_wall), self.width, self.height - int(self.top_wall))


# ===========================================================================
# M3 MODEL -- ERD 实体与领域行为
# ===========================================================================

@dataclass
class Brick:
    """A single brick.  ``hit()`` owns the INTACT->CRACKED->FADING->GONE transition."""
    brick_id: str
    row: int
    col: int
    points: int
    color: Tuple[int, int, int]
    max_hit_points: int = 1
    hit_points: int = 1
    rect: pygame.Rect = field(default_factory=lambda: pygame.Rect(0, 0, 0, 0))
    state: BrickState = BrickState.INTACT
    fade: float = 0.0

    @property
    def collidable(self) -> bool:
        """Only INTACT/CRACKED bricks block the ball (I3)."""
        return self.state in (BrickState.INTACT, BrickState.CRACKED)

    @property
    def damaged(self) -> bool:
        return self.hit_points < self.max_hit_points

    def hit(self) -> bool:
        """Apply one hit.  Returns True when the brick was destroyed."""
        self.hit_points -= 1
        if self.hit_points > 0:
            self.state = BrickState.CRACKED
            return False
        self.state = BrickState.FADING
        self.fade = BRICK_FADE_TIME
        return True

    def advance_fade(self, dt: float) -> bool:
        """Advance the fade-out.  Returns True when the brick becomes GONE."""
        if self.state is not BrickState.FADING:
            return False
        self.fade -= dt
        if self.fade <= 0.0:
            self.fade = 0.0
            self.state = BrickState.GONE
            return True
        return False


@dataclass
class ScoreEntry:
    """SCORE_ENTRY: audit row produced when a brick is destroyed."""
    entry_id: int
    brick_id: str
    base_points: int
    multiplier: int
    awarded: int


@dataclass
class Record:
    """RECORD: best results of this process (in-memory, see extension points)."""
    best_score: int = 0
    best_level: int = 1
    best_combo: int = 0

    def update(self, score: int, level: int, combo: int) -> None:
        self.best_score = max(self.best_score, score)
        self.best_level = max(self.best_level, level)
        self.best_combo = max(self.best_combo, combo)


@dataclass
class Settings:
    """SETTINGS: run-wide switches."""
    muted: bool = False
    fullscreen: bool = False
    window_size: Tuple[int, int] = (WINDOW_WIDTH, WINDOW_HEIGHT)
    instrument: str = DEFAULT_INSTRUMENT


@dataclass
class RunStats:
    """RUN: everything that describes the current play-through."""
    score: int = 0
    lives: int = STARTING_LIVES
    level: int = 1
    combo: int = 0
    best_combo: int = 0
    rally_multiplier: float = 1.0
    bricks_destroyed: int = 0
    entries: List[ScoreEntry] = field(default_factory=list)
    record: Record = field(default_factory=Record)
    _entry_seq: int = 0

    def add_entry(self, brick_id: str, base_points: int, multiplier: int, awarded: int) -> ScoreEntry:
        """Append a SCORE_ENTRY, keeping the log bounded (ring buffer)."""
        self._entry_seq += 1
        entry = ScoreEntry(self._entry_seq, brick_id, base_points, multiplier, awarded)
        self.entries.append(entry)
        if len(self.entries) > SCORE_LOG_LIMIT:
            del self.entries[: len(self.entries) - SCORE_LOG_LIMIT]
        return entry


@dataclass
class Popup:
    """POPUP: transient "+120" score marker (view model)."""
    x: float
    y: float
    text: str
    color: Tuple[int, int, int]
    life: float = POPUP_LIFE
    ttl: float = POPUP_LIFE


class Paddle:
    """PADDLE: continuous entity.  ``velocity`` (px/s) is the live input for R4."""

    def __init__(self) -> None:
        self.centerx: float = 0.0
        self.width: float = 130.0
        self.height: float = 14.0
        self.bottom: float = 0.0
        self.velocity: float = 0.0
        self.flash: float = 0.0

    @property
    def top(self) -> float:
        return self.bottom - self.height

    @property
    def left(self) -> float:
        return self.centerx - self.width * 0.5

    @property
    def right(self) -> float:
        return self.centerx + self.width * 0.5

    def rect(self) -> pygame.Rect:
        return pygame.Rect(
            int(round(self.left)),
            int(round(self.top)),
            max(1, int(round(self.width))),
            max(1, int(round(self.height))),
        )

    def move(self, direction: int, speed: float, dt: float, room_width: float) -> None:
        """Move inside the room and record the *actual* instantaneous velocity.

        Clamping at a wall therefore reports velocity 0, so pushing into a wall
        cannot add spin to the ball.
        """
        previous = self.centerx
        if direction:
            self.centerx += direction * speed * dt
        half = self.width * 0.5
        self.centerx = clamp(self.centerx, half, room_width - half)
        self.velocity = (self.centerx - previous) / dt if dt > 0.0 else 0.0


class Ball:
    """BALL: position/velocity in float pixels, plus its ATTACHED/IN_FLIGHT/LOST state."""

    def __init__(self) -> None:
        self.x: float = 0.0
        self.y: float = 0.0
        self.vx: float = 0.0
        self.vy: float = 0.0
        self.radius: float = 8.0
        self.state: BallState = BallState.ATTACHED

    @property
    def speed(self) -> float:
        return math.hypot(self.vx, self.vy)

    def set_direction(self, speed: float, angle: float) -> None:
        """Set the velocity from a speed and an angle (radians, 0 = straight up)."""
        self.vx = speed * math.sin(angle)
        self.vy = -speed * math.cos(angle)

    def set_magnitude(self, speed: float) -> None:
        """Rescale the velocity to *speed*, keeping the direction."""
        current = self.speed
        if current > 1e-9:
            factor = speed / current
            self.vx *= factor
            self.vy *= factor

    def scale_velocity(self, factor: float) -> None:
        self.vx *= factor
        self.vy *= factor

    def prevent_vertical_stall(self, min_ratio: float = MIN_HORIZONTAL_RATIO) -> None:
        """Guarantee a minimum horizontal component, preserving the speed (I2)."""
        speed = self.speed
        if speed <= 0.0:
            return
        min_vx = speed * min_ratio
        if 0.0 <= self.vx < min_vx:
            self.vx = min_vx
        elif -min_vx < self.vx < 0.0:
            self.vx = -min_vx
        self.set_magnitude(speed)

    def attach_to(self, paddle: Paddle) -> None:
        """R3: sit on the paddle, ready to be launched."""
        self.state = BallState.ATTACHED
        self.vx = 0.0
        self.vy = 0.0
        self.x = paddle.centerx
        self.y = paddle.top - self.radius - 1.0


# ===========================================================================
# M4 PHYSICS -- 碰撞检测与响应（不发分、不播音、不渲染）
# ===========================================================================

@dataclass(frozen=True)
class CollisionEvent:
    """COLLISION_EVENT: a fact produced by the engine and consumed by M10."""
    kind: HitKind
    x: float
    y: float
    speed: float
    brick_id: Optional[str] = None
    destroyed: bool = False


class CollisionEngine:
    """Ball versus room/paddle/bricks, resolved with sub-stepping against tunnelling."""

    def __init__(self, max_substeps: int = MAX_SUBSTEPS) -> None:
        self.max_substeps = max(1, int(max_substeps))

    # -- public API --------------------------------------------------------
    def step(
        self,
        ball: Ball,
        paddle: Paddle,
        bricks: Sequence[Brick],
        layout: FieldLayout,
        dt: float,
    ) -> List[CollisionEvent]:
        """Advance the ball by *dt* and return every collision that happened."""
        events: List[CollisionEvent] = []
        if dt <= 0.0:
            return events

        travel = ball.speed * dt
        max_step = max(2.0, ball.radius * 0.6)
        steps = int(min(self.max_substeps, max(1, math.ceil(travel / max_step))))
        sub_dt = dt / steps

        for _ in range(steps):
            ball.x += ball.vx * sub_dt
            ball.y += ball.vy * sub_dt

            event = self.walls(ball, layout)
            if event is not None:
                events.append(event)

            if ball.y - ball.radius > layout.height:            # R8
                ball.state = BallState.LOST
                events.append(CollisionEvent(HitKind.FLOOR, ball.x, ball.y, ball.speed))
                return events

            event = self.paddle_bounce(ball, paddle)            # R4
            if event is not None:
                events.append(event)

            event = self.bricks_bounce(ball, bricks)            # R6/R7
            if event is not None:
                events.append(event)

        ball.prevent_vertical_stall()
        return events

    # -- individual responses ---------------------------------------------
    def walls(self, ball: Ball, layout: FieldLayout) -> Optional[CollisionEvent]:
        """R5: mirror reflection off the left/right walls and the ceiling."""
        hit = False
        if ball.x - ball.radius < 0.0:
            ball.x = ball.radius
            ball.vx = abs(ball.vx)
            hit = True
        elif ball.x + ball.radius > layout.width:
            ball.x = layout.width - ball.radius
            ball.vx = -abs(ball.vx)
            hit = True
        if ball.y - ball.radius < layout.top_wall:
            ball.y = layout.top_wall + ball.radius
            ball.vy = abs(ball.vy)
            hit = True
        if not hit:
            return None
        return CollisionEvent(HitKind.WALL, ball.x, ball.y, ball.speed)

    def paddle_bounce(self, ball: Ball, paddle: Paddle) -> Optional[CollisionEvent]:
        """R4: reflect off the paddle using the hit offset *and* its instant motion.

        ``angle = clamp(PADDLE_MAX_BOUNCE_DEG * offset + PADDLE_SPIN_DEG * english)``
        where ``english`` is the paddle's instantaneous velocity normalised by
        PADDLE_SPIN_REF_SPEED.  Hitting the ball while sliding therefore changes
        the outgoing angle, exactly as the use case requires.
        """
        if ball.vy <= 0.0:
            return None
        if not (
            ball.y + ball.radius >= paddle.top
            and ball.y - ball.radius <= paddle.bottom
            and ball.x + ball.radius >= paddle.left
            and ball.x - ball.radius <= paddle.right
        ):
            return None

        ball.y = paddle.top - ball.radius
        half = paddle.width * 0.5
        offset = clamp((ball.x - paddle.centerx) / half, -1.0, 1.0) if half > 0 else 0.0
        english = clamp(paddle.velocity / PADDLE_SPIN_REF_SPEED, -1.0, 1.0)
        angle_deg = clamp(
            PADDLE_MAX_BOUNCE_DEG * offset + PADDLE_SPIN_DEG * english,
            -PADDLE_MAX_TOTAL_DEG,
            PADDLE_MAX_TOTAL_DEG,
        )
        speed = max(1.0, ball.speed)
        ball.set_direction(speed, math.radians(angle_deg))
        ball.prevent_vertical_stall()
        return CollisionEvent(HitKind.PADDLE, ball.x, ball.y, speed)

    def bricks_bounce(self, ball: Ball, bricks: Sequence[Brick]) -> Optional[CollisionEvent]:
        """R6/R7: resolve at most one brick hit per sub-step (I6)."""
        for brick in bricks:
            if not brick.collidable:
                continue
            contact = circle_rect_collision(ball.x, ball.y, ball.radius, brick.rect)
            if contact is None:
                continue

            nx, ny, penetration = contact
            approach = ball.vx * nx + ball.vy * ny
            if approach < 0.0:                      # only reflect when moving inwards
                ball.vx -= 2.0 * approach * nx
                ball.vy -= 2.0 * approach * ny
            # Separate the shapes so the next sub-step cannot re-detect the hit.
            ball.x += nx * (penetration + 0.01)
            ball.y += ny * (penetration + 0.01)

            destroyed = brick.hit()
            return CollisionEvent(
                HitKind.BRICK, ball.x, ball.y, ball.speed, brick.brick_id, destroyed
            )
        return None


# ===========================================================================
# M5 RULES -- 计分 / 连击 / 球速策略（纯函数）
# ===========================================================================

class ScoringRules:
    """Stateless policy: everything that turns game facts into numbers."""

    @staticmethod
    def combo_multiplier(combo: int) -> int:
        return int(min(1 + max(0, combo) // COMBO_STEP, COMBO_MAX))

    @staticmethod
    def brick_points(brick: Brick, combo: int) -> Tuple[int, int]:
        """Return ``(multiplier, awarded)`` for destroying *brick* at *combo*."""
        multiplier = ScoringRules.combo_multiplier(combo)
        return multiplier, brick.points * multiplier

    @staticmethod
    def level_bonus(level: int) -> int:
        return LEVEL_BONUS_BASE * max(1, level)

    @staticmethod
    def level_speed_factor(level: int) -> float:
        return 1.0 + LEVEL_SPEED_GROWTH * max(0, level - 1)

    @staticmethod
    def launch_speed(layout: FieldLayout, level: int, rally_multiplier: float) -> float:
        """Ball speed for the current level and rally length (capped)."""
        speed = layout.base_speed * ScoringRules.level_speed_factor(level) * rally_multiplier
        return min(speed, layout.base_speed * MAX_SPEED_FACTOR)

    @staticmethod
    def next_rally_multiplier(current: float) -> float:
        return min(current * (1.0 + PADDLE_RALLY_SPEEDUP), MAX_RALLY_MULTIPLIER)


# ===========================================================================
# M6 LEVELS -- 关卡 → 砖墙工厂
# ===========================================================================

class LevelFactory:
    """Builds brick walls.  Level parameters are derived from ``level_no``."""

    @staticmethod
    def rows_for_level(level: int) -> int:
        return int(min(BRICK_ROWS_BASE + (max(1, level) - 1) // 2, BRICK_ROWS_MAX))

    @staticmethod
    def brick_style(row: int, rows: int, level: int) -> Tuple[int, int, Tuple[int, int, int]]:
        """Return ``(hit_points, points, color)`` for one brick of the wall."""
        points = (rows - row) * 10
        hit_points = 2 if (level >= 3 and row == 0) else 1
        if hit_points > 1:
            points *= 2
        return hit_points, points, BRICK_COLORS[row % len(BRICK_COLORS)]

    @staticmethod
    def build(level: int, layout: FieldLayout) -> List[Brick]:
        rows = layout.rows
        bricks: List[Brick] = []
        for row in range(rows):
            for col in range(BRICK_COLUMNS):
                hit_points, points, color = LevelFactory.brick_style(row, rows, level)
                bricks.append(
                    Brick(
                        brick_id=f"L{level}R{row}C{col}",
                        row=row,
                        col=col,
                        points=points,
                        color=color,
                        max_hit_points=hit_points,
                        hit_points=hit_points,
                        rect=layout.brick_rect(row, col),
                    )
                )
        return bricks

    @staticmethod
    def reflow(bricks: Sequence[Brick], layout: FieldLayout) -> None:
        """Re-position an existing wall after the window changed size."""
        for brick in bricks:
            brick.rect = layout.brick_rect(brick.row, brick.col)


# ===========================================================================
# M7 AUDIO -- 程序化音效、音色预设与懒合成（无外部音频文件）
#   NOTE_TABLE     : 与音色无关的“乐谱”（音高滑动/时长/音量，v1.0.0 原值）
#   InstrumentPreset: 数据化的音色（泛音列/包络/瞬态），不含逻辑
#   render_note    : 纯函数合成器，输入 note + preset -> 16-bit PCM
#   SoundBank      : 生命周期/缓存/播放/静音/音色切换；对 M10 只暴露 play()
# 依赖方向：M7 -> M1（常量）；M10 -> M7；M8 只读 audio 状态用于 HUD。
# ===========================================================================

@dataclass(frozen=True)
class SoundNote:
    """One note recipe, independent of the instrument that renders it.

    ``NOTE_TABLE`` below is the game's score: exactly the pitches, durations and
    levels used since v1.0.0.  A preset only changes *how* a note is rendered,
    so every instrument plays the same music.
    """
    start_hz: float
    end_hz: float
    milliseconds: int
    volume: float


@dataclass(frozen=True)
class InstrumentPreset:
    """Data-only timbre definition: spectrum, envelope and attack transient.

    The preset holds no behaviour; ``render_note()`` interprets it.  Adding a
    new instrument therefore means adding one entry to ``INSTRUMENT_PRESETS``.
    ``gain`` is calibrated per preset so switching never changes loudness much.
    """
    key: str
    label: str
    partials: Tuple[float, ...]         # relative level of harmonic 1, 2, 3 ...
    attack_s: float = 0.004
    decay_ratio: float = 0.40           # decay time constant = duration * ratio
    noise: float = 0.0                  # hammer/pick transient level (0..1)
    noise_decay_s: float = 0.005
    gain: float = 1.0
    linear_decay: bool = False          # legacy SINE envelope: keeps v1.0.0 sound


# The note table is the single source of truth for the game's audible score.
# Every entry is played through SoundBank.play(name) by M10.
NOTE_TABLE: Dict[str, SoundNote] = {
    **{
        f"brick{index}": SoundNote(
            start_hz=520.0 + index * 55.0,
            end_hz=(520.0 + index * 55.0) * 1.35,
            milliseconds=60,
            volume=0.22,
        )
        for index in range(BRICK_TONES)
    },
    "paddle": SoundNote(300.0, 380.0, 70, 0.30),
    "wall": SoundNote(430.0, 430.0, 45, 0.16),
    "crack": SoundNote(240.0, 180.0, 70, 0.24),
    "launch": SoundNote(300.0, 700.0, 120, 0.24),
    "life_lost": SoundNote(420.0, 110.0, 520, 0.28),
    "level_clear": SoundNote(520.0, 1050.0, 320, 0.26),
    "game_over": SoundNote(440.0, 90.0, 800, 0.30),
    # Not a gameplay cue: a short, bright two-step chirp used to audition the
    # instrument when the player presses T.
    "preview": SoundNote(660.0, 990.0, 140, 0.22),
}

# Ordered cycle for the T key.  SINE is bit-for-bit the v1.0.0 voice and stays
# the default; the acoustic presets only change timbre (same NOTE_TABLE score).
INSTRUMENT_PRESETS: Dict[str, InstrumentPreset] = {
    "SINE": InstrumentPreset(
        key="SINE",
        label="SINE",
        partials=(1.0,),
        linear_decay=True,
    ),
    "PIANO": InstrumentPreset(
        key="PIANO",
        label="PIANO",
        partials=(1.0, 0.45, 0.28, 0.16, 0.09, 0.05),
        attack_s=0.003,
        decay_ratio=0.35,
        noise=0.10,                 # hammer thump
        noise_decay_s=0.004,
        gain=1.70,
    ),
    "CLASSICAL": InstrumentPreset(
        key="CLASSICAL",
        label="CLASSICAL",
        partials=(1.0, 0.32, 0.12, 0.05, 0.02),
        attack_s=0.006,
        decay_ratio=0.50,           # nylon strings ring a little longer
        noise=0.06,                 # finger / nail attack
        noise_decay_s=0.006,
        gain=1.40,
    ),
    "ACOUSTIC": InstrumentPreset(
        key="ACOUSTIC",
        label="ACOUSTIC",
        partials=(1.0, 0.55, 0.34, 0.20, 0.11, 0.06),
        attack_s=0.003,
        decay_ratio=0.38,
        noise=0.16,                 # steel-string pick attack
        noise_decay_s=0.003,
        gain=1.65,
    ),
}


def _note_hz(note: SoundNote, progress: float) -> float:
    """Linear pitch glide, matching the v1.0.0 sweep exactly."""
    return note.start_hz + (note.end_hz - note.start_hz) * progress


def build_wavetable(partials: Sequence[float], size: int = AUDIO_TABLE_SIZE) -> List[float]:
    """Sum one cycle of the preset's harmonic spectrum, normalised to 0.85 peak."""
    table = [0.0] * size
    for harmonic, amplitude in enumerate(partials, start=1):
        if amplitude == 0.0:
            continue
        step = 2.0 * math.pi * harmonic / size
        for index in range(size):
            table[index] += amplitude * math.sin(step * index)
    peak = max((abs(value) for value in table), default=1.0) or 1.0
    scale = 0.85 / peak
    return [value * scale for value in table]


def _noise_seed(preset: InstrumentPreset, note: SoundNote) -> int:
    """Stable seed so the transient noise is identical on every run/platform."""
    return (int(note.start_hz) * 31 + note.milliseconds) ^ (
        sum((index + 1) * ord(char) for index, char in enumerate(preset.key))
    )


def render_note(
    note: SoundNote,
    preset: InstrumentPreset,
    table: Sequence[float],
    rate: int,
    channels: int = 1,
) -> array:
    """Render one note to interleaved 16-bit little-endian PCM samples.

    Pure function (no pygame, no global state), so the synthesis is unit-testable
    without a window or an audio device.  ``table`` is ignored by legacy SINE.
    """
    count = max(1, int(rate * note.milliseconds / 1000.0))
    samples = array("h", bytes(2 * count * channels))
    amplitude = 32767.0 * note.volume * preset.gain

    if preset.linear_decay:
        # Legacy v1.0.0 voice: one sine, linear frequency glide, linear decay.
        phase = 0.0
        for index in range(count):
            progress = index / count
            hz = _note_hz(note, progress)
            phase += 2.0 * math.pi * hz / rate
            value = int(amplitude * (1.0 - progress) * math.sin(phase))
            for channel in range(channels):
                samples[index * channels + channel] = value
        return samples

    size = len(table)
    mask = size - 1
    inc_scale = size / rate
    attack = max(1, int(preset.attack_s * rate))
    tau = max(0.008, note.milliseconds / 1000.0 * preset.decay_ratio)
    decay = math.exp(-1.0 / (tau * rate))
    tail = max(1, int(AUDIO_TAIL_FADE * rate))
    use_noise = preset.noise > 0.0
    noise_samples = max(1, int(preset.noise_decay_s * rate * 4.0)) if use_noise else 0
    noise_decay = math.exp(-1.0 / (max(1e-4, preset.noise_decay_s) * rate))
    rng = random.Random(_noise_seed(preset, note))
    low = 0.0
    noise_env = 1.0
    phase = 0.0
    env = 0.0
    for index in range(count):
        hz = _note_hz(note, index / count)
        phase += hz * inc_scale
        if phase >= size:
            phase -= size
        position = int(phase)
        fraction = phase - position
        value = table[position] + (table[(position + 1) & mask] - table[position]) * fraction
        if use_noise and index < noise_samples:
            low += 0.32 * ((rng.random() * 2.0 - 1.0) - low)
            value += low * 4.0 * preset.noise * noise_env
            noise_env *= noise_decay
        if index < attack:
            env += 1.0 / attack
        else:
            env *= decay
        fade = 1.0
        if index > count - tail:
            fade = (count - index) / tail
        sample = int(max(-1.0, min(1.0, value * env * fade)) * amplitude)
        for channel in range(channels):
            samples[index * channels + channel] = sample
    return samples


class SoundBank:
    """Procedural sound effects with selectable instrument timbres.

    Each preset is synthesised lazily on first use and cached, so start-up keeps
    the v1.0.0 cost (~65 ms) and switching costs a one-off render (~100 ms).
    If the mixer or an audio device is unavailable (headless machines, some WSL
    setups), the bank disables itself and the game keeps running silently.
    """

    def __init__(self) -> None:
        self.enabled = False
        self.muted = False
        self.instrument = DEFAULT_INSTRUMENT
        self.sounds: Dict[str, pygame.mixer.Sound] = {}
        self._rate = 44100
        self._channels = 1
        self._cache: Dict[str, Dict[str, pygame.mixer.Sound]] = {}
        self._tables: Dict[str, List[float]] = {}
        try:
            if pygame.mixer.get_init() is None:
                pygame.mixer.init(frequency=44100, size=-16, channels=1, buffer=512)
            init = pygame.mixer.get_init()
            if not init:
                return
            self._rate, size, channels = init
            if size != -16 or channels < 1:
                return
            self._channels = int(channels)
            self.sounds = self._build_instrument(self.instrument)
            self._cache[self.instrument] = self.sounds
            self.enabled = True
        except (pygame.error, ValueError, TypeError):
            self.enabled = False

    # -- synthesis ---------------------------------------------------------
    def _table(self, key: str) -> List[float]:
        table = self._tables.get(key)
        if table is None:
            table = build_wavetable(INSTRUMENT_PRESETS[key].partials)
            self._tables[key] = table
        return table

    def _build_instrument(self, key: str) -> Dict[str, pygame.mixer.Sound]:
        preset = INSTRUMENT_PRESETS[key]
        table = self._table(key)
        built: Dict[str, pygame.mixer.Sound] = {}
        for name, note in NOTE_TABLE.items():
            samples = render_note(note, preset, table, self._rate, self._channels)
            if sys.byteorder == "big":      # keep the buffer little-endian for SDL
                samples.byteswap()
            built[name] = pygame.mixer.Sound(buffer=samples.tobytes())
        return built

    # -- instruments -------------------------------------------------------
    @property
    def instrument_label(self) -> str:
        """Display label of the active instrument (safe when audio is disabled)."""
        preset = INSTRUMENT_PRESETS.get(self.instrument)
        return preset.label if preset is not None else self.instrument

    def set_instrument(self, key: str) -> str:
        """Select *key*, synthesising and caching it on first use.

        The selection is model state: it changes even when audio is disabled, so
        the HUD and tests observe the same cycle on every machine.
        """
        if key not in INSTRUMENT_PRESETS:
            return self.instrument
        self.instrument = key
        if not self.enabled:
            return self.instrument
        try:
            if key not in self._cache:
                self._cache[key] = self._build_instrument(key)
            self.sounds = self._cache[key]
        except (pygame.error, ValueError, TypeError, OverflowError):
            self.enabled = False       # keep playing silently rather than crash
        return self.instrument

    def cycle_instrument(self, step: int = 1) -> str:
        """Cycle through the presets in declaration order (T key)."""
        keys = list(INSTRUMENT_PRESETS)
        try:
            current = keys.index(self.instrument)
        except ValueError:
            current = 0
        return self.set_instrument(keys[(current + step) % len(keys)])

    # -- playback ----------------------------------------------------------
    def play(self, name: str) -> None:
        if not self.enabled or self.muted:
            return
        sound = self.sounds.get(name)
        if sound is not None:
            try:
                sound.play()
            except pygame.error:
                self.enabled = False

    def toggle_mute(self) -> bool:
        self.muted = not self.muted
        return self.muted


# ===========================================================================
# M8 VIEW -- 渲染器（对模型只读）
# ===========================================================================

class Renderer:
    """Draws the session.  Never writes to any model object."""

    def __init__(self) -> None:
        self._fonts: Dict[Tuple[int, bool], pygame.font.Font] = {}
        self._background: Optional[pygame.Surface] = None
        self._background_size: Optional[Tuple[int, int]] = None

    # -- caches ------------------------------------------------------------
    def invalidate_background(self) -> None:
        self._background = None
        self._background_size = None

    def _font(self, size: int, bold: bool = False) -> pygame.font.Font:
        size = max(8, int(size))
        key = (size, bold)
        cached = self._fonts.get(key)
        if cached is None:
            cached = pygame.font.Font(None, size)
            cached.set_bold(bold)
            self._fonts[key] = cached
        return cached

    def _text(self, text: str, size: int, color, bold: bool = False) -> pygame.Surface:
        return self._font(size, bold).render(text, True, color)

    def _blit_text(
        self,
        screen: pygame.Surface,
        text: str,
        size: int,
        color,
        center: Optional[Tuple[float, float]] = None,
        midtop: Optional[Tuple[float, float]] = None,
        midleft: Optional[Tuple[float, float]] = None,
        midright: Optional[Tuple[float, float]] = None,
        bold: bool = False,
        shadow: bool = True,
    ) -> pygame.Rect:
        surface = self._text(text, size, color, bold)
        rect = surface.get_rect()
        if center is not None:
            rect.center = (int(center[0]), int(center[1]))
        elif midtop is not None:
            rect.midtop = (int(midtop[0]), int(midtop[1]))
        elif midleft is not None:
            rect.midleft = (int(midleft[0]), int(midleft[1]))
        elif midright is not None:
            rect.midright = (int(midright[0]), int(midright[1]))
        if shadow:
            shadow_surface = self._text(text, size, (0, 0, 0), bold)
            shadow_surface.set_alpha(110)
            screen.blit(shadow_surface, (rect.x + 2, rect.y + 2))
        screen.blit(surface, rect)
        return rect

    def background(self, layout: FieldLayout) -> pygame.Surface:
        size = (layout.width, layout.height)
        if self._background is None or self._background_size != size:
            surface = pygame.Surface(size).convert()
            top, bottom = COLOR_BG_TOP, COLOR_BG_BOTTOM
            for y in range(layout.height):
                blend = y / max(1, layout.height - 1)
                surface.fill(
                    (
                        int(top[0] + (bottom[0] - top[0]) * blend),
                        int(top[1] + (bottom[1] - top[1]) * blend),
                        int(top[2] + (bottom[2] - top[2]) * blend),
                    ),
                    pygame.Rect(0, y, layout.width, 1),
                )
            self._background = surface
            self._background_size = size
        return self._background

    @staticmethod
    def make_icon() -> pygame.Surface:
        icon = pygame.Surface((32, 32), pygame.SRCALPHA)
        icon.fill((0, 0, 0, 0))
        pygame.draw.rect(icon, (238, 92, 92), pygame.Rect(3, 3, 26, 7), border_radius=2)
        pygame.draw.rect(icon, (94, 176, 240), pygame.Rect(3, 13, 26, 7), border_radius=2)
        pygame.draw.rect(icon, COLOR_PADDLE, pygame.Rect(9, 25, 14, 4), border_radius=2)
        pygame.draw.circle(icon, COLOR_BALL, (16, 21), 3)
        return icon

    # -- main entry --------------------------------------------------------
    def draw(self, screen: pygame.Surface, session: "GameSession") -> None:
        layout = session.layout
        screen.blit(self.background(layout), (0, 0))
        self._draw_room(screen, layout)
        self._draw_bricks(screen, session)
        self._draw_paddle(screen, session.paddle)
        self._draw_ball(screen, session.ball)
        self._draw_popups(screen, session)
        self._draw_hud(screen, session)
        self._draw_overlays(screen, session)

    # -- layers ------------------------------------------------------------
    def _draw_room(self, screen: pygame.Surface, layout: FieldLayout) -> None:
        """Make the "limited room" explicit: ceiling + floor edge."""
        pygame.draw.line(
            screen, COLOR_ACCENT, (0, int(layout.top_wall)), (layout.width, int(layout.top_wall)), 2
        )
        pygame.draw.line(
            screen,
            COLOR_FLOOR_EDGE,
            (0, layout.height - 2),
            (layout.width, layout.height - 2),
            3,
        )

    def _paint_brick(
        self, target: pygame.Surface, rect: pygame.Rect, brick: Brick
    ) -> None:
        radius = max(2, int(rect.height * 0.22))
        pygame.draw.rect(target, brick.color, rect, border_radius=radius)
        highlight = pygame.Rect(
            rect.x + 2,
            rect.y + 2,
            max(1, rect.width - 4),
            max(1, int(rect.height * 0.28)),
        )
        shade = tuple(min(255, channel + 46) for channel in brick.color)
        pygame.draw.rect(target, shade, highlight, border_radius=radius)
        if brick.damaged:
            inset = rect.inflate(
                -max(2, rect.width // 4), -max(2, rect.height // 3)
            )
            dark = tuple(int(channel * 0.62) for channel in brick.color)
            pygame.draw.rect(target, dark, inset, width=2, border_radius=2)

    def _draw_bricks(self, screen: pygame.Surface, session: "GameSession") -> None:
        fade_time = max(1e-6, BRICK_FADE_TIME)
        for brick in session.bricks:
            if brick.state is BrickState.GONE:
                continue
            if brick.state is BrickState.FADING:
                # R7: fade out -- shrink slightly and lower the alpha.
                alpha = clamp(brick.fade / fade_time, 0.0, 1.0)
                shrink = int(round((1.0 - alpha) * max(2, brick.rect.height * 0.3)))
                rect = pygame.Rect(
                    brick.rect.x + shrink,
                    brick.rect.y + shrink,
                    max(1, brick.rect.width - 2 * shrink),
                    max(1, brick.rect.height - 2 * shrink),
                )
                surface = pygame.Surface(rect.size, pygame.SRCALPHA)
                self._paint_brick(surface, pygame.Rect(0, 0, rect.width, rect.height), brick)
                surface.set_alpha(int(255 * alpha))
                screen.blit(surface, rect.topleft)
                continue
            self._paint_brick(screen, brick.rect, brick)

    def _draw_paddle(self, screen: pygame.Surface, paddle: Paddle) -> None:
        rect = paddle.rect()
        radius = max(3, rect.height // 2)
        pygame.draw.rect(screen, COLOR_PADDLE, rect, border_radius=radius)
        if paddle.flash > 0.0:
            pygame.draw.rect(screen, COLOR_PADDLE_EDGE, rect, width=2, border_radius=radius)
        highlight = pygame.Rect(
            rect.x + 2, rect.y + 2, max(1, rect.width - 4), max(1, rect.height // 3)
        )
        pygame.draw.rect(screen, COLOR_PADDLE_EDGE, highlight, border_radius=radius)

    def _draw_ball(self, screen: pygame.Surface, ball: Ball) -> None:
        center = (int(round(ball.x)), int(round(ball.y)))
        radius = max(2, int(round(ball.radius)))
        pygame.draw.circle(screen, COLOR_BALL, center, radius)
        glow = max(1, radius // 3)
        pygame.draw.circle(
            screen, (255, 255, 255), (center[0] - glow, center[1] - glow), max(1, radius // 3)
        )

    def _draw_popups(self, screen: pygame.Surface, session: "GameSession") -> None:
        size = int(clamp(session.layout.height * 0.026, 14, 26))
        for popup in session.popups:
            alpha = clamp(popup.life / popup.ttl, 0.0, 1.0)
            surface = self._text(popup.text, size, popup.color, True)
            surface.set_alpha(int(255 * alpha))
            screen.blit(surface, surface.get_rect(center=(int(popup.x), int(popup.y))))

    def _draw_hud(self, screen: pygame.Surface, session: "GameSession") -> None:
        layout = session.layout
        stats = session.stats
        height = int(layout.hud_height)
        hud = pygame.Rect(0, 0, layout.width, height)
        panel = pygame.Surface(hud.size, pygame.SRCALPHA)
        panel.fill((*COLOR_PANEL, 214))
        screen.blit(panel, hud.topleft)

        pad = max(10.0, layout.width * 0.022)
        main_size = int(clamp(layout.height * 0.030, 16, 30))
        small_size = int(clamp(layout.height * 0.024, 13, 24))
        middle = height * 0.44
        badge_y = height * 0.80

        self._blit_text(
            screen, f"SCORE {stats.score}", main_size, COLOR_TEXT, midleft=(pad, middle)
        )
        self._blit_text(
            screen,
            f"BEST {max(stats.record.best_score, stats.score)}",
            small_size,
            COLOR_TEXT_DIM,
            center=(layout.width * 0.5, middle),
        )

        level_surface = self._text(f"LEVEL {stats.level}", main_size, COLOR_TEXT)
        level_rect = level_surface.get_rect(midright=(int(layout.width - pad), int(middle)))
        screen.blit(level_surface, level_rect)

        # Lives drawn as little balls to the left of the level label.
        icon_radius = max(3, int(layout.hud_height * 0.09))
        spacing = icon_radius * 3
        x = level_rect.left - pad - icon_radius
        for _ in range(max(0, stats.lives)):
            pygame.draw.circle(screen, COLOR_BALL, (int(x), int(level_rect.centery)), icon_radius)
            x -= spacing

        multiplier = session.combo_multiplier
        if multiplier > 1:
            self._blit_text(
                screen,
                f"COMBO x{multiplier}",
                int(clamp(layout.height * 0.022, 12, 22)),
                COLOR_ACCENT,
                center=(layout.width * 0.5, badge_y),
                bold=True,
            )

        sound_label = f"SND {session.audio.instrument_label}"
        if session.audio.muted:
            sound_label += " | MUTED"
        self._blit_text(
            screen,
            sound_label,
            int(clamp(layout.height * 0.021, 11, 20)),
            COLOR_TEXT_DIM,
            midright=(layout.width - pad, badge_y),
        )

    def _dim(self, layout: FieldLayout, alpha: int) -> pygame.Surface:
        surface = pygame.Surface((layout.width, layout.height), pygame.SRCALPHA)
        surface.fill((6, 8, 18, alpha))
        return surface

    def _draw_overlays(self, screen: pygame.Surface, session: "GameSession") -> None:
        state = session.state
        if state is RunState.PLAYING:
            return

        layout = session.layout
        stats = session.stats
        center_y = (layout.top_wall + layout.height) * 0.5
        width = layout.width
        height = layout.height

        if state is RunState.READY:
            # A brand new run gets the title card; after losing a life the player
            # only needs the short "launch again" prompt.
            screen.blit(self._dim(layout, 150 if session.fresh_run else 90), (0, 0))
            if session.fresh_run:
                self._blit_text(
                    screen,
                    "BRICK BREAKER",
                    int(clamp(height * 0.085, 30, 78)),
                    COLOR_ACCENT,
                    center=(width * 0.5, center_y),
                    bold=True,
                )
                self._blit_text(
                    screen,
                    "SPACE to launch the ball",
                    int(clamp(height * 0.032, 16, 32)),
                    COLOR_TEXT,
                    center=(width * 0.5, center_y + height * 0.085),
                )
                self._blit_text(
                    screen,
                    "Left / Right arrows move the paddle    P pause    F fullscreen    T sound    Q quit",
                    int(clamp(height * 0.023, 12, 23)),
                    COLOR_TEXT_DIM,
                    center=(width * 0.5, center_y + height * 0.15),
                )
            else:
                self._blit_text(
                    screen,
                    "SPACE to launch",
                    int(clamp(height * 0.055, 22, 50)),
                    COLOR_ACCENT,
                    center=(width * 0.5, center_y),
                    bold=True,
                )
                self._blit_text(
                    screen,
                    "Left / Right arrows move the paddle    T sound",
                    int(clamp(height * 0.024, 13, 24)),
                    COLOR_TEXT_DIM,
                    center=(width * 0.5, center_y + height * 0.065),
                )

        elif state is RunState.PAUSED:
            screen.blit(self._dim(layout, 165), (0, 0))
            self._blit_text(
                screen,
                "PAUSED",
                int(clamp(height * 0.08, 28, 72)),
                COLOR_TEXT,
                center=(width * 0.5, center_y - height * 0.02),
                bold=True,
            )
            self._blit_text(
                screen,
                "P to resume    R to restart    Q to quit",
                int(clamp(height * 0.028, 15, 28)),
                COLOR_TEXT_DIM,
                center=(width * 0.5, center_y + height * 0.06),
            )

        elif state is RunState.LEVEL_CLEAR:
            self._blit_text(
                screen,
                session.banner_text,
                int(clamp(height * 0.055, 22, 52)),
                COLOR_ACCENT,
                center=(width * 0.5, center_y),
                bold=True,
            )

        elif state is RunState.GAME_OVER:
            screen.blit(self._dim(layout, 190), (0, 0))
            self._blit_text(
                screen,
                "GAME OVER",
                int(clamp(height * 0.10, 34, 92)),
                COLOR_DANGER,
                center=(width * 0.5, center_y - height * 0.02),
                bold=True,
            )
            self._blit_text(
                screen,
                f"Score {stats.score}    Best {stats.record.best_score}",
                int(clamp(height * 0.038, 18, 38)),
                COLOR_TEXT,
                center=(width * 0.5, center_y + height * 0.09),
            )
            self._blit_text(
                screen,
                f"Level {stats.level}    Longest combo {max(stats.record.best_combo, stats.best_combo)}",
                int(clamp(height * 0.026, 14, 26)),
                COLOR_TEXT_DIM,
                center=(width * 0.5, center_y + height * 0.145),
            )
            self._blit_text(
                screen,
                "R  restart        Q  quit",
                int(clamp(height * 0.040, 19, 40)),
                COLOR_ACCENT,
                center=(width * 0.5, center_y + height * 0.225),
                bold=True,
            )


# ===========================================================================
# M9 INPUT -- 事件 → Intent
# ===========================================================================

@dataclass(frozen=True)
class Input:
    """One translated input; RESIZE carries the requested size."""
    intent: Intent
    width: int = 0
    height: int = 0


class InputController:
    """Maps SDL events to intents and keeps the held-key state for the paddle axis."""

    KEY_INTENTS: Dict[int, Intent] = {
        pygame.K_q: Intent.QUIT,
        pygame.K_ESCAPE: Intent.QUIT,
        pygame.K_m: Intent.TOGGLE_MUTE,
        pygame.K_t: Intent.CYCLE_INSTRUMENT,
        pygame.K_f: Intent.TOGGLE_FULLSCREEN,
        pygame.K_r: Intent.RESTART,
        pygame.K_p: Intent.TOGGLE_PAUSE,
        pygame.K_SPACE: Intent.PRIMARY,
        pygame.K_UP: Intent.PRIMARY,
        pygame.K_RETURN: Intent.PRIMARY,
    }

    def __init__(self) -> None:
        self.held: set = set()

    @property
    def axis(self) -> int:
        """-1 (left), 0 (idle) or +1 (right)."""
        left = pygame.K_LEFT in self.held or pygame.K_a in self.held
        right = pygame.K_RIGHT in self.held or pygame.K_d in self.held
        return (1 if right else 0) - (1 if left else 0)

    def clear(self) -> None:
        self.held.clear()

    def handle(self, event: pygame.event.Event) -> List[Input]:
        if event.type == pygame.QUIT:
            return [Input(Intent.QUIT)]

        if event.type == pygame.VIDEORESIZE:
            return [Input(Intent.RESIZE, int(event.w), int(event.h))]

        if event.type == pygame.WINDOWFOCUSLOST:
            # Without this the paddle can keep sliding if a KEYUP was missed
            # while the window was in the background.
            self.clear()
            return [Input(Intent.FOCUS_LOST)]

        if event.type == pygame.KEYDOWN:
            self.held.add(event.key)
            intent = self.KEY_INTENTS.get(event.key)
            return [Input(intent)] if intent is not None else []

        if event.type == pygame.KEYUP:
            self.held.discard(event.key)

        return []


# ===========================================================================
# M10 SESSION -- 运行状态机
# ===========================================================================

class GameSession:
    """The run state machine: the only place that assigns ``RunState``."""

    def __init__(self, width: int, height: int, audio: Optional[SoundBank] = None) -> None:
        self.settings = Settings(window_size=(int(width), int(height)))
        self.stats = RunStats()
        self.audio = audio if audio is not None else SoundBank()
        self.physics = CollisionEngine()

        self.layout = FieldLayout.compute(width, height, LevelFactory.rows_for_level(1))
        self.paddle = Paddle()
        self.ball = Ball()
        self.bricks: List[Brick] = []
        self._brick_index: Dict[str, Brick] = {}
        self.bricks_left = 0
        self.popups: List[Popup] = []

        self.state = RunState.READY
        self.level_timer = 0.0
        self.banner_text = ""
        self.fresh_run = True
        self.move_axis = 0

        self._apply_layout()
        self.new_run()

    # -- transitions -------------------------------------------------------
    def new_run(self) -> None:
        """Start a brand new run (also used by Intent.RESTART)."""
        self.stats = RunStats()
        self.popups.clear()
        self.fresh_run = True
        self.move_axis = 0
        self.banner_text = ""
        self.level_timer = 0.0
        self.build_level()
        self.prepare_ball()

    def build_level(self) -> None:
        """Create the wall for ``stats.level`` and reset the level bookkeeping."""
        rows = LevelFactory.rows_for_level(self.stats.level)
        if rows != self.layout.rows:
            self.layout = FieldLayout.compute(self.layout.width, self.layout.height, rows)
            self._apply_layout()
        self.bricks = LevelFactory.build(self.stats.level, self.layout)
        self._brick_index = {brick.brick_id: brick for brick in self.bricks}
        self.bricks_left = len(self.bricks)
        self.stats.rally_multiplier = 1.0
        self.stats.combo = 0

    def attach_ball(self) -> None:
        """R3: park the ball on the paddle (BallState.ATTACHED)."""
        if self.paddle.centerx <= 0.0:
            self.paddle.centerx = self.layout.width * 0.5
        self.paddle.centerx = clamp(
            self.paddle.centerx,
            self.paddle.width * 0.5,
            self.layout.width - self.paddle.width * 0.5,
        )
        self.ball.attach_to(self.paddle)

    def prepare_ball(self) -> None:
        """Park the ball and enter READY, waiting for the launch key."""
        self.attach_ball()
        self.state = RunState.READY

    def launch_ball(self) -> None:
        """READY -> PLAYING with a random launch angle."""
        angle = math.radians(random.uniform(28.0, 55.0)) * random.choice((-1.0, 1.0))
        speed = ScoringRules.launch_speed(
            self.layout, self.stats.level, self.stats.rally_multiplier
        )
        self.ball.set_direction(speed, angle)
        self.ball.state = BallState.IN_FLIGHT
        self.fresh_run = False
        self.state = RunState.PLAYING
        self.audio.play("launch")

    def next_level(self) -> None:
        self.stats.level += 1
        self.build_level()
        self.prepare_ball()

    def finish_level(self) -> None:
        bonus = ScoringRules.level_bonus(self.stats.level)
        self.stats.score += bonus
        self.banner_text = f"LEVEL {self.stats.level} CLEARED  +{bonus}"
        self.state = RunState.LEVEL_CLEAR
        self.level_timer = LEVEL_CLEAR_DELAY
        self.audio.play("level_clear")

    def lose_life(self) -> None:
        """R8: the ball reached the floor.  One life gone, or game over."""
        self.audio.play("life_lost")
        self.stats.best_combo = max(self.stats.best_combo, self.stats.combo)
        self.stats.combo = 0
        self.stats.rally_multiplier = 1.0
        self.stats.lives -= 1
        self.ball.state = BallState.LOST
        if self.stats.lives <= 0:
            self.game_over()
        else:
            self.prepare_ball()

    def game_over(self) -> None:
        self.stats.lives = 0
        self.stats.record.update(self.stats.score, self.stats.level, self.stats.best_combo)
        self.state = RunState.GAME_OVER
        self.move_axis = 0
        self.audio.play("game_over")

    # -- input -------------------------------------------------------------
    def set_move_axis(self, axis: int) -> None:
        self.move_axis = -1 if axis < 0 else (1 if axis > 0 else 0)

    def apply(self, intent: Intent) -> None:
        """Apply a game-level intent inside the current state."""
        if intent is Intent.RESTART:
            self.new_run()

        elif intent is Intent.TOGGLE_MUTE:
            self.settings.muted = self.audio.toggle_mute()

        elif intent is Intent.CYCLE_INSTRUMENT:
            # M7 owns the timbre bank; the chosen preset name stays in the model
            # so the HUD and tests can read it back without touching the mixer.
            self.settings.instrument = self.audio.cycle_instrument()
            self.audio.play("preview")

        elif intent is Intent.FOCUS_LOST:
            if self.state is RunState.PLAYING:
                self.state = RunState.PAUSED

        elif intent is Intent.TOGGLE_PAUSE:
            if self.state is RunState.PLAYING:
                self.state = RunState.PAUSED
            elif self.state is RunState.PAUSED:
                self.state = RunState.PLAYING

        elif intent is Intent.PRIMARY:
            if self.state is RunState.READY:
                self.launch_ball()
            elif self.state is RunState.LEVEL_CLEAR:
                self.level_timer = 0.0
            elif self.state is RunState.GAME_OVER:
                self.new_run()

    # -- simulation --------------------------------------------------------
    def update(self, dt: float) -> None:
        if self.state in (RunState.PLAYING, RunState.READY, RunState.LEVEL_CLEAR):
            self._move_paddle(dt)

        if self.state is RunState.PLAYING:
            events = self.physics.step(self.ball, self.paddle, self.bricks, self.layout, dt)
            for event in events:
                if self.state is not RunState.PLAYING:
                    break                   # a transition already stopped play
                self._consume(event)
        elif self.state is RunState.READY:
            self.ball.attach_to(self.paddle)    # keep riding the paddle (R3)
        elif self.state is RunState.LEVEL_CLEAR:
            self.level_timer -= dt
            if self.level_timer <= 0.0:
                self.next_level()

        if self.state is not RunState.PAUSED:
            self._advance_animation(dt)     # R7: fade-outs & pop-ups (frozen when paused)
        if self.paddle.flash > 0.0:
            self.paddle.flash = max(0.0, self.paddle.flash - dt)

    def _advance_animation(self, dt: float) -> None:
        """R7 fade-outs and pop-ups; frozen while paused."""
        self._advance_fades(dt)
        self._advance_popups(dt)

    def _move_paddle(self, dt: float) -> None:
        speed = max(360.0, self.layout.width * 1.0)
        self.paddle.move(self.move_axis, speed, dt, self.layout.width)

    def _consume(self, event: CollisionEvent) -> None:
        """Turn a physics fact into score, sound and state changes."""
        if event.kind is HitKind.WALL:
            self.audio.play("wall")

        elif event.kind is HitKind.PADDLE:
            self.audio.play("paddle")
            self.paddle.flash = 0.12
            self.stats.best_combo = max(self.stats.best_combo, self.stats.combo)
            self.stats.combo = 0
            self.stats.rally_multiplier = ScoringRules.next_rally_multiplier(
                self.stats.rally_multiplier
            )
            # The engine chose the direction (offset + english); the rule set
            # decides how fast the rally has become.
            self.ball.set_magnitude(
                ScoringRules.launch_speed(
                    self.layout, self.stats.level, self.stats.rally_multiplier
                )
            )

        elif event.kind is HitKind.BRICK:
            self._on_brick_hit(event)

        elif event.kind is HitKind.FLOOR:
            self.lose_life()

    def _on_brick_hit(self, event: CollisionEvent) -> None:
        if not event.destroyed:
            self.audio.play("crack")            # cracked but still standing
            return

        brick = self._brick_index.get(event.brick_id or "")
        if brick is None:
            return

        self.bricks_left -= 1
        self.stats.bricks_destroyed += 1
        self.stats.combo += 1
        multiplier, awarded = ScoringRules.brick_points(brick, self.stats.combo)
        self.stats.score += awarded
        self.stats.add_entry(brick.brick_id, brick.points, multiplier, awarded)
        self.popups.append(
            Popup(
                x=brick.rect.centerx,
                y=brick.rect.centery,
                text=f"+{awarded}" + (f" x{multiplier}" if multiplier > 1 else ""),
                color=COLOR_ACCENT if multiplier > 1 else COLOR_TEXT,
            )
        )
        self.audio.play(f"brick{brick.row % BRICK_TONES}")

        if self.bricks_left <= 0:
            self.finish_level()

    def _advance_fades(self, dt: float) -> None:
        removed = False
        for brick in self.bricks:
            if brick.advance_fade(dt):
                removed = True
        if removed:
            self.bricks = [brick for brick in self.bricks if brick.state is not BrickState.GONE]
            self._brick_index = {brick.brick_id: brick for brick in self.bricks}

    def _advance_popups(self, dt: float) -> None:
        if not self.popups:
            return
        alive: List[Popup] = []
        for popup in self.popups:
            popup.life -= dt
            popup.y -= POPUP_RISE * dt
            if popup.life > 0.0:
                alive.append(popup)
        self.popups = alive

    # -- window / geometry -------------------------------------------------
    def resize(self, width: int, height: int) -> None:
        """Re-derive the room and keep everything in the same relative place."""
        old_layout = self.layout
        old_width = max(1, old_layout.width)
        old_height = max(1, old_layout.height)
        old_base = max(1e-6, old_layout.base_speed)

        self.layout = FieldLayout.compute(width, height, old_layout.rows)
        self.settings.window_size = (self.layout.width, self.layout.height)
        self._apply_layout()

        self.paddle.centerx = clamp(
            self.paddle.centerx * self.layout.width / old_width,
            self.paddle.width * 0.5,
            self.layout.width - self.paddle.width * 0.5,
        )
        self.ball.scale_velocity(self.layout.base_speed / old_base)
        self.ball.x = clamp(
            self.ball.x * self.layout.width / old_width,
            self.ball.radius,
            self.layout.width - self.ball.radius,
        )
        self.ball.y = self.layout.height * (self.ball.y / old_height)
        if self.state is RunState.READY:
            self.ball.attach_to(self.paddle)

    def _apply_layout(self) -> None:
        """Push derived sizes into the entities and re-position the wall (M3/M6)."""
        layout = self.layout
        self.paddle.width = layout.paddle_width
        self.paddle.height = layout.paddle_height
        self.paddle.bottom = layout.paddle_bottom
        self.ball.radius = layout.ball_radius
        LevelFactory.reflow(self.bricks, layout)

    # -- queries -----------------------------------------------------------
    @property
    def combo_multiplier(self) -> int:
        return ScoringRules.combo_multiplier(self.stats.combo)

    @property
    def active_bricks(self) -> List[Brick]:
        """Bricks that are not GONE (fading ones included)."""
        return [brick for brick in self.bricks if brick.state is not BrickState.GONE]

    def brick_by_id(self, brick_id: str) -> Optional[Brick]:
        return self._brick_index.get(brick_id)


# ===========================================================================
# M11 APP -- 窗口与固定步长主循环
# ===========================================================================

class App:
    """Window bootstrap, event dispatch and the fixed-timestep loop."""

    def __init__(self, size: Optional[Tuple[int, int]] = None) -> None:
        pygame.display.set_caption("Brick Breaker")
        self.fullscreen = False
        self.windowed_size = tuple(size) if size else self._preferred_window_size()
        self.screen = pygame.display.set_mode(self.windowed_size, pygame.RESIZABLE)
        pygame.display.set_icon(Renderer.make_icon())

        self.clock = pygame.time.Clock()
        self.audio = SoundBank()
        self.session = GameSession(
            self.screen.get_size()[0], self.screen.get_size()[1], audio=self.audio
        )
        self.session.settings.fullscreen = self.fullscreen
        self.renderer = Renderer()
        self.input = InputController()
        self.accumulator = 0.0

    # -- window ------------------------------------------------------------
    @staticmethod
    def _preferred_window_size() -> Tuple[int, int]:
        """Pick a window that fits the desktop, keeping the design aspect ratio."""
        try:
            desktop_w, desktop_h = pygame.display.get_desktop_sizes()[0]
        except (pygame.error, IndexError, AttributeError):
            return WINDOW_WIDTH, WINDOW_HEIGHT

        aspect = WINDOW_WIDTH / WINDOW_HEIGHT
        height = int(clamp(desktop_h * 0.82, 480, WINDOW_HEIGHT))
        width = int(clamp(height * aspect, 640, max(640, desktop_w * 0.90)))
        height = int(clamp(width / aspect, 420, max(420, desktop_h * 0.92)))
        return width, height

    def on_resize(self, width: int, height: int) -> None:
        """Keep the drawing surface and the logical room in sync.

        In fullscreen the surface size belongs to the display, so the logical
        size simply follows it.
        """
        width = max(240, int(width))
        height = max(200, int(height))
        if not self.fullscreen and self.screen.get_size() != (width, height):
            self.screen = pygame.display.set_mode((width, height), pygame.RESIZABLE)
            self.renderer.invalidate_background()
        if self.session.layout.width == width and self.session.layout.height == height:
            return
        self.session.resize(width, height)
        self.renderer.invalidate_background()

    def toggle_fullscreen(self) -> None:
        self.fullscreen = not self.fullscreen
        try:
            if self.fullscreen:
                self.screen = pygame.display.set_mode((0, 0), pygame.FULLSCREEN)
            else:
                self.screen = pygame.display.set_mode(self.windowed_size, pygame.RESIZABLE)
        except pygame.error:
            # Fall back to a window if the display refuses fullscreen.
            self.fullscreen = False
            self.screen = pygame.display.set_mode(self.windowed_size, pygame.RESIZABLE)
        self.session.settings.fullscreen = self.fullscreen
        self.renderer.invalidate_background()
        self.on_resize(*self.screen.get_size())

    # -- event dispatch ----------------------------------------------------
    def handle_event(self, event: pygame.event.Event) -> bool:
        """Translate one SDL event; returns False when the app should stop."""
        for item in self.input.handle(event):
            if item.intent is Intent.QUIT:
                return False
            if item.intent is Intent.RESIZE:
                self.on_resize(item.width, item.height)
            elif item.intent is Intent.TOGGLE_FULLSCREEN:
                self.toggle_fullscreen()
            else:
                self.session.apply(item.intent)
        return True

    # -- frame steps -------------------------------------------------------
    def update(self, dt: float) -> None:
        self.session.set_move_axis(self.input.axis)
        self.session.update(dt)

    def draw(self) -> None:
        self.renderer.draw(self.screen, self.session)

    def run(self) -> None:
        running = True
        while running:
            frame_time = min(self.clock.tick(TARGET_FPS) / 1000.0, MAX_FRAME_TIME)

            for event in pygame.event.get():
                if not self.handle_event(event):
                    running = False
                    break
            if not running:
                break

            # Fixed-timestep simulation: identical behaviour on every machine.
            self.accumulator = min(self.accumulator + frame_time, MAX_FRAME_TIME)
            while self.accumulator >= PHYSICS_STEP:
                self.update(PHYSICS_STEP)
                self.accumulator -= PHYSICS_STEP

            self.draw()
            pygame.display.flip()

    # -- compatibility facade ---------------------------------------------
    # Thin pass-throughs so existing harnesses that used the older `Game`
    # class keep working unchanged.
    @property
    def state(self) -> RunState:
        return self.session.state

    @property
    def stats(self) -> RunStats:
        return self.session.stats

    @property
    def score(self) -> int:
        return self.session.stats.score

    @score.setter
    def score(self, value: int) -> None:
        self.session.stats.score = int(value)

    @property
    def lives(self) -> int:
        return self.session.stats.lives

    @lives.setter
    def lives(self, value: int) -> None:
        self.session.stats.lives = int(value)

    @property
    def level(self) -> int:
        return self.session.stats.level

    @level.setter
    def level(self, value: int) -> None:
        self.session.stats.level = int(value)

    @property
    def combo(self) -> int:
        return self.session.stats.combo

    @property
    def high_score(self) -> int:
        return self.session.stats.record.best_score

    @property
    def best_combo(self) -> int:
        return self.session.stats.record.best_combo

    @property
    def bricks(self) -> List[Brick]:
        return self.session.bricks

    @property
    def bricks_left(self) -> int:
        return self.session.bricks_left

    @property
    def ball(self) -> Ball:
        return self.session.ball

    @property
    def paddle(self) -> Paddle:
        return self.session.paddle

    @property
    def popups(self) -> List[Popup]:
        return self.session.popups

    @property
    def sounds(self) -> SoundBank:
        return self.session.audio

    @property
    def layout(self) -> FieldLayout:
        return self.session.layout

    @property
    def w(self) -> int:
        return self.session.layout.width

    @property
    def h(self) -> int:
        return self.session.layout.height

    @property
    def top_wall(self) -> float:
        return self.session.layout.top_wall

    @property
    def hud_height(self) -> float:
        return self.session.layout.hud_height

    @property
    def base_speed(self) -> float:
        return self.session.layout.base_speed

    @property
    def fresh_run(self) -> bool:
        return self.session.fresh_run

    @property
    def banner_text(self) -> str:
        return self.session.banner_text

    def combo_multiplier(self) -> int:
        return self.session.combo_multiplier

    def new_run(self) -> None:
        self.session.new_run()

    def build_level(self) -> None:
        self.session.build_level()

    def launch_ball(self) -> None:
        self.session.launch_ball()

    def prepare_ball(self) -> None:
        self.session.prepare_ball()

    def attach_ball(self) -> None:
        self.session.attach_ball()

    def finish_level(self) -> None:
        self.session.finish_level()


# Alias kept for backwards compatibility with older scripts / test harnesses.
Game = App


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    # Must run before pygame.init() so the mixer opens with a known format.
    try:
        pygame.mixer.pre_init(frequency=44100, size=-16, channels=1, buffer=512)
    except pygame.error:
        pass

    pygame.init()
    try:
        if pygame.version.vernum < (2, 0, 0):
            print(
                "Brick Breaker needs Pygame 2.0 or newer "
                f"(found {pygame.version.ver}). Install it with:\n"
                "    python -m pip install pygame-ce",
                file=sys.stderr,
            )
            return 1
        App().run()
    except KeyboardInterrupt:
        # Ctrl+C in a terminal is a normal way to stop the game on Linux.
        return 0
    except pygame.error as error:
        print(f"Pygame could not start a display or audio device: {error}", file=sys.stderr)
        print("On a headless server, run with SDL_VIDEODRIVER=dummy.", file=sys.stderr)
        return 1
    finally:
        pygame.quit()
    return 0


if __name__ == "__main__":
    sys.exit(main())
