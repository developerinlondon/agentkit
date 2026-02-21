#!/usr/bin/env python3
"""Fix ASCII box alignment in markdown files — handles nested boxes inside-out.

Scans markdown code blocks for box-drawing characters and ensures all lines
within each box have their right │ at the correct column (matching the ┐ of
that box's top border). Processes innermost boxes first, then works outward.

Only processes code blocks where the first non-empty line starts with ┌ at
column 0 (true outer enclosing box). Tree diagrams with indented boxes are
skipped.

Usage:
    python3 tools/fix-ascii-boxes.py [file...]
    python3 tools/fix-ascii-boxes.py                  # scans all .md files
    python3 tools/fix-ascii-boxes.py --check           # validate only, exit 1 on failure
    python3 tools/fix-ascii-boxes.py path/to/file.md   # fix specific file(s)
"""

import sys
import os
import glob
import re

VERT = "│"
BORDER_CHARS = set("─┬┼┤├┐┌")


def has_outer_box(block_lines: list[tuple[int, str]]) -> bool:
    for _, line in block_lines:
        stripped = line.rstrip()
        if stripped.startswith("┌") and stripped.endswith("┐"):
            return True
        if stripped:
            return False
    return False


def find_boxes(block_lines: list[tuple[int, str]]) -> list[dict]:
    top_stack: list[dict] = []
    boxes: list[dict] = []

    for idx, (line_num, content) in enumerate(block_lines):
        for m in re.finditer("┌", content):
            col = m.start()
            for end_pos in range(col + 1, len(content)):
                if content[end_pos] == "┐":
                    segment = content[col + 1 : end_pos]
                    if all(c in BORDER_CHARS for c in segment):
                        top_stack.append(
                            {"left": col, "right": end_pos, "top_idx": idx}
                        )

        for m in re.finditer("└", content):
            col = m.start()
            for end_pos in range(col + 1, len(content)):
                if content[end_pos] == "┘":
                    for i in range(len(top_stack) - 1, -1, -1):
                        t = top_stack[i]
                        if t["left"] == col and t["right"] == end_pos:
                            top_stack.pop(i)
                            boxes.append(
                                {
                                    "left": col,
                                    "right": end_pos,
                                    "top_idx": t["top_idx"],
                                    "bottom_idx": idx,
                                }
                            )
                            break

    for box in boxes:
        depth = sum(
            1
            for other in boxes
            if other is not box
            and other["left"] <= box["left"]
            and other["right"] >= box["right"]
            and other["top_idx"] <= box["top_idx"]
            and other["bottom_idx"] >= box["bottom_idx"]
            and (other["left"] < box["left"] or other["right"] > box["right"])
        )
        box["depth"] = depth

    boxes.sort(key=lambda b: -b["depth"])
    return boxes


def find_vert_near(content: str, target_col: int, search_range: int = 3) -> int:
    if 0 <= target_col < len(content) and content[target_col] == VERT:
        return target_col
    for offset in range(1, search_range + 1):
        for check_col in [target_col - offset, target_col + offset]:
            if 0 <= check_col < len(content) and content[check_col] == VERT:
                return check_col
    return -1


def shift_vert_at(content: str, actual_col: int, target_col: int) -> str | None:
    if actual_col == target_col or content[actual_col] != VERT:
        return content

    delta = target_col - actual_col

    if delta > 0:
        space_after_count = 0
        pos = actual_col + 1
        while pos < len(content) and content[pos] == " ":
            space_after_count += 1
            pos += 1
        if space_after_count < delta:
            return None
        return (
            content[:actual_col]
            + " " * delta
            + VERT
            + content[actual_col + 1 + delta :]
        )

    remove = -delta
    space_before_count = 0
    pos = actual_col - 1
    while pos >= 0 and content[pos] == " ":
        space_before_count += 1
        pos -= 1
    if space_before_count < remove:
        return None
    return (
        content[: actual_col - remove]
        + VERT
        + " " * remove
        + content[actual_col + 1 :]
    )


def check_and_fix_block(
    block_lines: list[tuple[int, str]], check_only: bool, filepath: str
) -> tuple[list[str], dict[int, str]]:
    issues: list[str] = []
    fixes: dict[int, str] = {}
    working: dict[int, str] = {
        idx: content for idx, (_, content) in enumerate(block_lines)
    }

    boxes = find_boxes(block_lines)

    for box in boxes:
        left_col = box["left"]
        right_col = box["right"]

        for idx in range(box["top_idx"] + 1, box["bottom_idx"]):
            line_num = block_lines[idx][0]
            content = working[idx]

            if len(content) <= left_col:
                continue
            if content[left_col] not in "│├":
                continue

            actual_right = find_vert_near(content, right_col)
            if actual_right < 0 or actual_right == right_col:
                continue

            diff = actual_right - right_col
            issue_msg = (
                f"{filepath}:{line_num + 1}: inner │ at col {actual_right}, "
                f"expected {right_col} (box {left_col}-{right_col}, "
                f"diff={diff:+d})"
            )

            if check_only:
                issues.append(issue_msg)
            else:
                fixed = shift_vert_at(content, actual_right, right_col)
                if fixed and len(fixed) == len(content):
                    working[idx] = fixed
                    fixes[idx] = fixed
                else:
                    issues.append(issue_msg + " UNFIXABLE")

    return issues, fixes


def process_file(filepath: str, check_only: bool = False) -> list[str]:
    with open(filepath, "r", encoding="utf-8") as f:
        lines = f.readlines()

    all_issues: list[str] = []
    in_code = False
    block_lines: list[tuple[int, str]] = []
    blocks: list[list[tuple[int, str]]] = []

    for i, line in enumerate(lines):
        stripped = line.rstrip("\n")
        if stripped.strip() == "```":
            if not in_code:
                in_code = True
                block_lines = []
            else:
                if block_lines and has_outer_box(block_lines):
                    blocks.append(list(block_lines))
                in_code = False
                block_lines = []
        elif in_code:
            block_lines.append((i, stripped))

    fixed_lines = list(lines)
    changes_made = False

    for block in blocks:
        issues, fixes = check_and_fix_block(block, check_only, filepath)
        all_issues.extend(issues)
        for idx, fixed_content in fixes.items():
            line_idx = block[idx][0]
            fixed_lines[line_idx] = fixed_content + "\n"
            changes_made = True

    if changes_made and not check_only:
        with open(filepath, "w", encoding="utf-8") as f:
            f.writelines(fixed_lines)

    return all_issues


def find_md_files(root: str = ".") -> list[str]:
    return sorted(glob.glob(os.path.join(root, "**", "*.md"), recursive=True))


def main():
    check_only = "--check" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--check"]
    files = args if args else find_md_files()

    if not files:
        print("No markdown files found.")
        return 0

    all_issues: list[str] = []
    for f in files:
        if not os.path.isfile(f):
            print(f"WARNING: {f} not found, skipping", file=sys.stderr)
            continue
        all_issues.extend(process_file(f, check_only=check_only))

    if all_issues:
        action = "found" if check_only else "remaining after fix"
        print(f"FAIL: {len(all_issues)} misaligned lines {action}:")
        for issue in all_issues:
            print(f"  {issue}")
        return 1

    action = "validated" if check_only else "fixed"
    print(f"PASS: All ASCII boxes aligned ({len(files)} files {action})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
