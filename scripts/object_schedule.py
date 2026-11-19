"""Evaluate map-entry object placements controlled by event flags and the clock."""
from __future__ import annotations

from dataclasses import dataclass, replace
import re
from typing import TYPE_CHECKING, Iterator

import atlas_common

if TYPE_CHECKING:
    from generate_object_metadata import ASMConstantParser, ObjectEventEntry


def eusine_state(flags: set[str]) -> str:
    # GetEusineState checks permanent milestones before the Suicune encounter.
    for flag, state in (
        ("EVENT_EUSINE_HO_OH_FAREWELL", "EUSINE_TRAVELING"),
        ("EVENT_EUSINE_HO_OH_ENCOUNTER", "EUSINE_FAREWELL_PENDING"),
        ("EVENT_EUSINE_LEFT_CELADON", "EUSINE_LEFT_CELADON"),
        ("EVENT_FOUGHT_SUICUNE", "EUSINE_RESEARCHING"),
    ):
        if flag in flags:
            return state
    return "EUSINE_SEARCHING"


def eusine_masks(state: str) -> dict[str, bool]:
    return {"EVENT_EUSINES_HOUSE_EUSINE": state != "EUSINE_RESEARCHING",
            "EVENT_TIN_TOWER_1F_EUSINE": state != "EUSINE_FAREWELL_PENDING"}


def caught_beasts(flags: set[str]) -> bool:
    return {"ENGINE_PLAYER_CAUGHT_RAIKOU", "ENGINE_PLAYER_CAUGHT_ENTEI", "ENGINE_PLAYER_CAUGHT_SUICUNE"} <= flags


@dataclass
class ObjectSchedule:
    entry: str
    lines: list[str]
    labels: dict[str, int]
    names: list[str]
    rematch_body: list[str]
    reads_scene: bool

    @classmethod
    def parse(cls, source: str) -> ObjectSchedule | None:
        if "MAPCALLBACK_OBJECTS" not in source:
            return None
        lines = list(atlas_common.scoped_map_lines(source.splitlines()))
        entries = [match[1] for line in lines
                   if (match := re.fullmatch(r"callback\s+MAPCALLBACK_OBJECTS,\s*([\w.]+)", line))]
        if len(entries) != 1 or "object_const_def" not in lines:
            return None
        entry = entries[0]
        macro = re.search(r"^\s*MACRO\s+rematch\b[^\n]*\n(.*?)^\s*ENDM\b", source, re.M | re.S)
        names = []
        for line in lines[lines.index("object_const_def") + 1:]:
            if not line:
                continue
            if not line.startswith("const "):
                break
            names.append(line.split()[1])
        labels = {line[:-1]: i + 1 for i, line in enumerate(lines) if line.endswith(":")}
        body = [line.strip() for line in macro[1].splitlines() if line.strip()] if macro else []
        if entry not in labels:
            return None
        # Only execute complete callbacks. Assembly, persistent scene state
        # and player input can select an entirely different object placement.
        pending = [(labels[entry], False)]
        visited = set()
        has_placements = False
        reads_scene = False
        while pending:
            pos, has_result = pending.pop()
            if (pos, has_result) in visited:
                continue
            if pos >= len(lines):
                return None
            visited.add((pos, has_result))
            line = lines[pos]
            if line == "endcallback":
                continue
            if line == "checkscene":
                reads_scene = True
                pending.append((pos + 1, True))
                continue
            if line and not line.endswith(":"):
                parts = line.split(None, 1)
                if len(parts) != 2:
                    return None
                op, rest = parts
                if op in {"ifequal", "ifequalfwd", "ifgreater", "iftruefwd", "iffalsefwd", "sjumpfwd"}:
                    target = labels.get(rest.split(",")[-1].strip())
                    if target is None or target <= pos or (op != "sjumpfwd" and not has_result):
                        return None
                    pending.append((target, has_result))
                    if op == "sjumpfwd":
                        continue
                elif op in {"moveobject", "appear", "disappear", "turnobject", "setmapobjectpal"}:
                    if rest.split(",")[0].strip() not in names:
                        return None
                    has_placements = True
                elif op == "rematch" and body:
                    has_placements = True
                elif op in {"setevent", "clearevent"} and rest.startswith("EVENT_"):
                    has_placements = True
                elif op == "special" and rest in {"UpdateEusineVisibility", "SpecialBeastsCheck"}:
                    has_result = True
                    if rest == "UpdateEusineVisibility":
                        has_placements = True
                elif op in {"checkflag", "checkevent", "checktime"} or (op == "readvar" and rest in {"VAR_WEEKDAY", "VAR_UNOWNCOUNT"}):
                    has_result = True
                elif op not in {"variablesprite", "setscene"}:
                    return None
            pending.append((pos + 1, has_result))
        return cls(entry, lines, labels, names, body, reads_scene) if has_placements else None

    def commands(self, constants: ASMConstantParser, flags: set[str], weekday: int, time: str,
                 *, scene: int = 0, unown_count: int = 0
                 ) -> Iterator[tuple[str, list[str]]]:
        pos = self.labels[self.entry]
        visited = set()
        result = None
        scene_values = {line.split(",")[-1].split()[-1]: index for index, line in enumerate(
            line for line in self.lines if line.startswith(("scene_script ", "scene_const ")))}
        flags = flags.copy()
        while pos not in visited:
            visited.add(pos)
            line = self.lines[pos]
            pos += 1
            if not line or line.endswith(":"):
                continue
            if line == "endcallback":
                return
            if line == "checkscene":
                result = scene
                continue
            op, rest = line.split(None, 1)
            args = [arg.strip() for arg in rest.split(",")]
            if op == "readvar" and rest == "VAR_WEEKDAY":
                result = weekday
            elif op == "readvar" and rest == "VAR_UNOWNCOUNT":
                result = unown_count
            elif op == "setscene":
                scene = scene_values[rest] if rest in scene_values else _value(constants, rest)
            elif op in ("checkevent", "checkflag"):
                result = int(rest in flags)
            elif op == "special" and rest == "SpecialBeastsCheck":
                result = caught_beasts(flags)
            elif op == "special" and rest == "UpdateEusineVisibility":
                state = eusine_state(flags)
                result = _value(constants, state)
                for flag, hidden in eusine_masks(state).items():
                    if hidden:
                        flags.add(flag)
                    else:
                        flags.discard(flag)
                    yield ("setevent" if hidden else "clearevent"), [flag]
            elif op in ("setevent", "clearevent"):
                if op == "setevent":
                    flags.add(rest)
                else:
                    flags.discard(rest)
                yield op, args
            elif op == "checktime":
                result = bool(_value(constants, rest) & (1 << _value(constants, time.upper())))
            elif op in ("ifequal", "ifequalfwd", "ifgreater"):
                operand = scene_values[args[0]] if args[0] in scene_values else _value(constants, args[0])
                if (result > operand if op == "ifgreater" else result == operand):
                    pos = self.labels[args[1]]
            elif op in ("iftruefwd", "iffalsefwd", "sjumpfwd"):
                if op == "sjumpfwd" or bool(result) == (op == "iftruefwd"):
                    pos = self.labels[args[0]]
            elif op == "rematch":
                for cmd in self.rematch_body:
                    expanded = re.sub(r"\\(\d+)", lambda m: args[int(m[1]) - 1], cmd)
                    name, operands = expanded.split(None, 1)
                    yield name, [arg.strip() for arg in operands.split(",")]
            else:
                yield op, args
        raise ValueError(f"Cyclic schedule in {self.entry}")


def _value(constants: ASMConstantParser, expression: str) -> int:
    value = constants.evaluate(expression)
    if value is None:
        raise ValueError(f"Unresolved map object schedule operand {expression}")
    return value


def scheduled_objects(source: str, objects: list[ObjectEventEntry], constants: ASMConstantParser,
                      flags: set[str], weekday: int, times: tuple[str, ...],
                      forced_set: set[str], forced_clear: set[str]) -> dict[str, list[ObjectEventEntry]]:
    schedule = ObjectSchedule.parse(source)
    if schedule is None:
        return {}
    by_time = {}
    for time in times:
        rows = [replace(obj) for obj in objects]
        named = dict(zip(schedule.names, rows))
        slots = {obj.sprite_constant: obj for obj in rows}
        for command, (name, *args) in schedule.commands(constants, flags, weekday, time):
            if command in ("appear", "disappear"):
                named[name].event_flag_set = command == "disappear"
            elif command in ("setevent", "clearevent"):
                for obj in rows:
                    if obj.event_flag == name:
                        obj.event_flag_set = command == "setevent"
            elif command == "setmapobjectpal":
                named[name].palette_value = _value(constants, args[0])
                named[name].palette_constant = None
            elif command == "variablesprite":
                slots[name].resolved_sprite = args[0]
            elif command == "moveobject":
                named[name].x_tiles, named[name].y_tiles = (_value(constants, arg) for arg in args)
            elif command == "turnobject":
                obj = named[name]
                if not obj.movement_constant.startswith("SPRITEMOVEDATA_STANDING_"):
                    raise ValueError(f"Unexpected scheduled movement for {name}")
                obj.movement_constant = "SPRITEMOVEDATA_STANDING_" + args[0]
                obj.movement_id = _value(constants, obj.movement_constant)
            else:
                raise ValueError(f"Unsupported object callback operation in {schedule.entry}: {command}")
        for obj in rows:
            if obj.event_flag in forced_set:
                obj.event_flag_set = True
            elif obj.event_flag in forced_clear:
                obj.event_flag_set = False
        if rows != objects:
            by_time[time] = rows
    return by_time
