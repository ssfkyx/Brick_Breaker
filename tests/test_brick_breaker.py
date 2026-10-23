"""Headless unit tests for the single-file Brick Breaker game (bb_v1).

The suite uses only the Python standard library (``unittest``) plus Pygame, so
it needs no extra test dependencies.  SDL is forced onto its dummy drivers
*before* Pygame is imported, which keeps the tests runnable on a CI runner or a
headless server without a display or a sound device.

Run it from the repository root:

    python -m unittest discover -s tests -v

The module imports ``bb_v1/brick_breaker.py`` (the only implementation), so no
part of the game is copied into the test tree.  Every test is deterministic:
randomness is seeded, time is driven by fixed ``PHYSICS_STEP`` updates, and no
test sleeps or reads the wall clock.
"""

from __future__ import annotations

import math
import os
import random
import sys
import unittest

# Headless SDL: must be configured before Pygame (or the game module) initialise
# any subsystem, and before any import of `pygame` happens below.
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")
os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BB_V1_DIR = os.path.join(REPO_ROOT, "bb_v1")
if BB_V1_DIR not in sys.path:
    sys.path.insert(0, BB_V1_DIR)

import pygame  # noqa: E402  (import order is deliberate: SDL env first)

import brick_breaker as bb  # noqa: E402


SEED = 20261023


class HeadlessPygameTestCase(unittest.TestCase):
    """Give every test a fresh Pygame session and always shut it down."""

    def setUp(self) -> None:
        pygame.init()
        random.seed(SEED)

    def tearDown(self) -> None:
        pygame.quit()


# ---------------------------------------------------------------------------
# M1 CONFIG / M2 GEOMETRY
# ---------------------------------------------------------------------------

class ConfigTests(HeadlessPygameTestCase):
    def test_config_and_enum_wiring(self) -> None:
        """The documented tunables and state-machine enums are wired as specified."""
        self.assertEqual(bb.WINDOW_WIDTH, 960)
        self.assertEqual(bb.WINDOW_HEIGHT, 720)
        self.assertGreater(bb.TARGET_FPS, 0)
        # Fixed 120 Hz simulation, with a strict upper bound between two steps.
        self.assertAlmostEqual(bb.PHYSICS_STEP, 1.0 / 120.0)
        self.assertLess(bb.PHYSICS_STEP, bb.MAX_FRAME_TIME)
        self.assertGreaterEqual(bb.MAX_SUBSTEPS, 1)

        self.assertEqual(bb.BRICK_COLUMNS, 11)
        self.assertLessEqual(bb.BRICK_ROWS_BASE, bb.BRICK_ROWS_MAX)
        self.assertEqual(bb.STARTING_LIVES, 3)
        self.assertEqual(bb.COMBO_STEP, 4)
        self.assertEqual(bb.COMBO_MAX, 5)
        self.assertEqual(bb.LEVEL_BONUS_BASE, 250)
        self.assertAlmostEqual(bb.BRICK_FADE_TIME, 0.30)
        # Balancing invariants that the rest of the rules rely on.
        self.assertGreater(bb.MAX_SPEED_FACTOR, 1.0)
        self.assertLessEqual(bb.MAX_RALLY_MULTIPLIER, bb.MAX_SPEED_FACTOR)
        self.assertGreaterEqual(len(bb.BRICK_COLORS), bb.BRICK_ROWS_MAX)

        self.assertEqual(
            [state.value for state in bb.RunState],
            ["ready", "playing", "paused", "level_clear", "game_over"],
        )
        self.assertEqual(
            [state.value for state in bb.BallState], ["attached", "in_flight", "lost"]
        )
        self.assertEqual(
            [state.value for state in bb.BrickState],
            ["intact", "cracked", "fading", "gone"],
        )
        self.assertEqual(
            [kind.value for kind in bb.HitKind], ["wall", "paddle", "brick", "floor"]
        )
        # The compatibility aliases still point at the same enum members.
        self.assertIs(bb.STATE_READY, bb.RunState.READY)
        self.assertIs(bb.STATE_PLAY, bb.RunState.PLAYING)
        self.assertIs(bb.STATE_OVER, bb.RunState.GAME_OVER)


class GeometryTests(HeadlessPygameTestCase):
    def test_brick_grid_stays_inside_the_room(self) -> None:
        """The derived grid, paddle and ball sizes fit the documented room."""
        layout = bb.FieldLayout.compute(bb.WINDOW_WIDTH, bb.WINDOW_HEIGHT, bb.BRICK_ROWS_MAX)
        self.assertEqual((layout.width, layout.height), (bb.WINDOW_WIDTH, bb.WINDOW_HEIGHT))
        self.assertEqual(layout.rows, bb.BRICK_ROWS_MAX)
        self.assertGreater(layout.top_wall, 0.0)
        self.assertLess(layout.top_wall, layout.height)
        self.assertGreater(layout.paddle_width, 0.0)
        self.assertGreater(layout.paddle_height, 0.0)
        self.assertGreater(layout.ball_radius, 0.0)

        first = layout.brick_rect(0, 0)
        last = layout.brick_rect(layout.rows - 1, bb.BRICK_COLUMNS - 1)
        self.assertGreaterEqual(first.left, 0)
        self.assertGreaterEqual(first.top, layout.top_wall)
        self.assertLessEqual(last.right, layout.width)
        self.assertLess(last.bottom, layout.paddle_bottom)

        # The room starts below the HUD and the paddle lives inside it.
        self.assertEqual(layout.room_rect.top, int(layout.top_wall))
        self.assertLess(layout.paddle_bottom, layout.height)
        self.assertGreater(layout.paddle_bottom, layout.height * 0.75)

        # Degenerate window requests are clamped to a usable minimum.
        tiny = bb.FieldLayout.compute(10, 10, 0)
        self.assertGreaterEqual(tiny.width, 240)
        self.assertGreaterEqual(tiny.height, 200)
        self.assertGreaterEqual(tiny.rows, 1)


# ---------------------------------------------------------------------------
# M3 MODEL: the brick state machine (R7: INTACT -> CRACKED -> FADING -> GONE)
# ---------------------------------------------------------------------------

class BrickStateMachineTests(HeadlessPygameTestCase):
    def _brick(self, hit_points: int) -> bb.Brick:
        return bb.Brick(
            brick_id=f"L1R0C0-HP{hit_points}",
            row=0,
            col=0,
            points=70,
            color=(10, 20, 30),
            max_hit_points=hit_points,
            hit_points=hit_points,
        )

    def test_brick_damage_state_machine(self) -> None:
        """HP 1: INTACT -> FADING -> GONE; HP 2: INTACT -> CRACKED -> FADING."""
        single = self._brick(1)
        self.assertIs(single.state, bb.BrickState.INTACT)
        self.assertTrue(single.collidable)
        self.assertFalse(single.damaged)

        self.assertTrue(single.hit())  # destroyed on the first hit
        self.assertIs(single.state, bb.BrickState.FADING)
        self.assertFalse(single.collidable)  # I3: no second score while fading
        self.assertAlmostEqual(single.fade, bb.BRICK_FADE_TIME)
        self.assertFalse(single.advance_fade(bb.BRICK_FADE_TIME / 2.0))
        self.assertIs(single.state, bb.BrickState.FADING)
        self.assertTrue(single.advance_fade(bb.BRICK_FADE_TIME))
        self.assertIs(single.state, bb.BrickState.GONE)
        self.assertFalse(single.collidable)

        tough = self._brick(2)
        self.assertIs(tough.state, bb.BrickState.INTACT)
        self.assertFalse(tough.hit())  # cracked but still standing
        self.assertIs(tough.state, bb.BrickState.CRACKED)
        self.assertTrue(tough.collidable)
        self.assertTrue(tough.damaged)
        self.assertEqual(tough.hit_points, 1)

        self.assertTrue(tough.hit())  # second hit destroys it
        self.assertIs(tough.state, bb.BrickState.FADING)
        self.assertFalse(tough.collidable)
        self.assertEqual(tough.hit_points, 0)


# ---------------------------------------------------------------------------
# M5 RULES: pure scoring / combo / speed policy
# ---------------------------------------------------------------------------

class ScoringRulesTests(HeadlessPygameTestCase):
    def test_combo_multiplier_ladder_and_brick_points(self) -> None:
        self.assertEqual(bb.ScoringRules.combo_multiplier(0), 1)
        self.assertEqual(bb.ScoringRules.combo_multiplier(bb.COMBO_STEP - 1), 1)
        self.assertEqual(bb.ScoringRules.combo_multiplier(bb.COMBO_STEP), 2)
        self.assertEqual(bb.ScoringRules.combo_multiplier(bb.COMBO_STEP * 2), 3)
        self.assertEqual(bb.ScoringRules.combo_multiplier(bb.COMBO_STEP * (bb.COMBO_MAX - 1)), bb.COMBO_MAX)
        self.assertEqual(bb.ScoringRules.combo_multiplier(10_000), bb.COMBO_MAX)
        # Never decreases as the combo grows.
        multipliers = [bb.ScoringRules.combo_multiplier(combo) for combo in range(0, 40)]
        self.assertEqual(multipliers, sorted(multipliers))

        brick = bb.Brick(
            brick_id="L1R2C3", row=2, col=3, points=40, color=(1, 2, 3)
        )
        self.assertEqual(bb.ScoringRules.brick_points(brick, 0), (1, 40))
        self.assertEqual(bb.ScoringRules.brick_points(brick, bb.COMBO_STEP * 2), (3, 120))

    def test_level_bonus_and_speed_policy(self) -> None:
        self.assertEqual(bb.ScoringRules.level_bonus(1), bb.LEVEL_BONUS_BASE)
        self.assertEqual(bb.ScoringRules.level_bonus(4), bb.LEVEL_BONUS_BASE * 4)
        self.assertEqual(bb.ScoringRules.level_bonus(0), bb.LEVEL_BONUS_BASE)  # clamped

        self.assertAlmostEqual(bb.ScoringRules.level_speed_factor(1), 1.0)
        self.assertAlmostEqual(
            bb.ScoringRules.level_speed_factor(3), 1.0 + 2.0 * bb.LEVEL_SPEED_GROWTH
        )
        self.assertGreater(bb.ScoringRules.level_speed_factor(8), bb.ScoringRules.level_speed_factor(2))

        layout = bb.FieldLayout.compute(bb.WINDOW_WIDTH, bb.WINDOW_HEIGHT, bb.BRICK_ROWS_BASE)
        base = layout.base_speed
        self.assertAlmostEqual(bb.ScoringRules.launch_speed(layout, 1, 1.0), base)
        # Both the level ramp and the rally boost are capped.
        capped = bb.ScoringRules.launch_speed(layout, 10_000, 10.0)
        self.assertAlmostEqual(capped, base * bb.MAX_SPEED_FACTOR)

        rally = 1.0
        for _ in range(1_000):
            rally = bb.ScoringRules.next_rally_multiplier(rally)
        self.assertAlmostEqual(rally, bb.MAX_RALLY_MULTIPLIER)
        self.assertGreater(bb.ScoringRules.next_rally_multiplier(1.0), 1.0)


# ---------------------------------------------------------------------------
# M10 SESSION / M11 APP: window, launch, simulation and game over
# ---------------------------------------------------------------------------

class SessionTests(HeadlessPygameTestCase):
    def test_launch_ball_moves_on_fixed_timestep(self) -> None:
        session = bb.GameSession(480, 360)
        self.assertIs(session.state, bb.RunState.READY)
        self.assertIs(session.ball.state, bb.BallState.ATTACHED)
        self.assertEqual(session.stats.lives, bb.STARTING_LIVES)

        session.apply(bb.Intent.PRIMARY)
        self.assertIs(session.state, bb.RunState.PLAYING)
        self.assertIs(session.ball.state, bb.BallState.IN_FLIGHT)
        self.assertGreater(session.ball.speed, 0.0)

        start_x, start_y = session.ball.x, session.ball.y
        for _ in range(5):
            session.update(bb.PHYSICS_STEP)

        travelled = math.hypot(session.ball.x - start_x, session.ball.y - start_y)
        self.assertGreater(travelled, 0.5)
        self.assertIs(session.state, bb.RunState.PLAYING)
        self.assertGreaterEqual(session.ball.x, session.ball.radius)
        self.assertLessEqual(session.ball.x, session.layout.width - session.ball.radius)

    def test_losing_all_lives_reaches_game_over(self) -> None:
        session = bb.GameSession(480, 360)
        self.assertEqual(session.stats.lives, bb.STARTING_LIVES)

        for remaining in (2, 1):
            session.apply(bb.Intent.PRIMARY)
            self.assertIs(session.state, bb.RunState.PLAYING)
            self._drop_ball_below_the_floor(session)
            session.update(bb.PHYSICS_STEP)
            self.assertEqual(session.stats.lives, remaining)
            self.assertIs(session.state, bb.RunState.READY)
            self.assertIs(session.ball.state, bb.BallState.ATTACHED)

        # The last life is lost after another floor collision: GAME_OVER, R restarts.
        session.apply(bb.Intent.PRIMARY)
        self._drop_ball_below_the_floor(session)
        session.update(bb.PHYSICS_STEP)
        self.assertEqual(session.stats.lives, 0)
        self.assertIs(session.state, bb.RunState.GAME_OVER)
        self.assertIs(session.ball.state, bb.BallState.LOST)

        session.apply(bb.Intent.RESTART)
        self.assertIs(session.state, bb.RunState.READY)
        self.assertEqual(session.stats.lives, bb.STARTING_LIVES)
        self.assertEqual(session.stats.score, 0)

    @staticmethod
    def _drop_ball_below_the_floor(session: bb.GameSession) -> None:
        """Put the in-flight ball past the floor so physics reports HitKind.FLOOR."""
        layout = session.layout
        session.ball.state = bb.BallState.IN_FLIGHT
        session.ball.x = layout.width * 0.5
        session.ball.y = layout.height + session.ball.radius + 8.0
        session.ball.vx = 0.0
        session.ball.vy = session.layout.base_speed


class AppTests(HeadlessPygameTestCase):
    def test_app_constructs_renders_and_resizes(self) -> None:
        app = bb.App((320, 240))
        self.assertEqual(app.screen.get_size(), (320, 240))
        self.assertEqual(app.session.layout.width, 320)
        self.assertEqual(app.session.layout.height, 240)
        self.assertIs(app.state, bb.RunState.READY)
        self.assertGreater(app.bricks_left, 0)
        self.assertEqual(len(app.bricks), app.bricks_left)

        # Renderer.draw writes the frame; flip is a headless no-op.
        app.draw()
        pygame.display.flip()

        # The frame is actually painted: sample the gradient + brick/HUD layers.
        colours = {
            app.screen.get_at((x, y))[:3]
            for x in range(0, 320, 32)
            for y in range(0, 240, 24)
        }
        self.assertGreater(len(colours), 2)

        app.on_resize(400, 300)
        self.assertEqual(app.session.layout.width, 400)
        self.assertEqual(app.session.layout.height, 300)
        self.assertEqual(app.screen.get_size(), (400, 300))
        app.draw()
        pygame.display.flip()


if __name__ == "__main__":
    unittest.main(verbosity=2)
