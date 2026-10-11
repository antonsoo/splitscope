"""Constructed XML controls, never represented as recorded gameplay."""
from copy import deepcopy
from pathlib import Path
import xml.etree.ElementTree as ET


def controls():
    modern = ET.fromstring(Path("tests/fixtures/combined-best.lss").read_text())
    for attempt in modern.findall("AttemptHistory/Attempt"):
        ET.SubElement(attempt, "PauseTime").text = "00:00:01.2500000"
    legacy = ET.fromstring(Path("tests/fixtures/legacy-1.0.lss").read_text())
    ET.SubElement(legacy, "GameIcon")  # required by the reference, ignored by Splitscope
    rows = []

    def add(name, root, same_as=None, error=None):
        rows.append({"id": name, "xml": ET.tostring(root, encoding="unicode"),
                     "same_as": same_as, "error": error})

    for label, base in [("modern", modern), ("legacy", legacy)]:
        add(label, base)
        attributed = deepcopy(base)
        for node in attributed.iter():
            if len(node) == 0:
                node.set("xml:space", "preserve")
        add(f"{label}/all-leaf-attributes", attributed, label)

    for tag in ["RealTime", "GameTime", "PauseTime", "GameName", "CategoryName",
                "Offset", "AttemptCount", "Name"]:
        root = deepcopy(modern)
        for node in root.iter(tag):
            node.set("xml:space", "preserve")
        add(f"modern/attributed-{tag}", root, "modern")

    # Attribute-only empty time elements must still mean not recorded.
    for attributed in [False, True]:
        root = deepcopy(modern)
        for tag in ["RealTime", "GameTime", "PauseTime"]:
            for node in root.iter(tag):
                node.text = None
                if attributed:
                    node.set("xml:space", "preserve")
        add("empty-attributed" if attributed else "empty", root,
            "empty" if attributed else None)

    paths = ["GameName", "CategoryName", "Offset", "AttemptCount", "Segments",
             "AttemptHistory", "AttemptHistory/Attempt/PauseTime",
             "Segments/Segment/Name", "Segments/Segment/SplitTimes",
             "Segments/Segment/BestSegmentTime", "Segments/Segment/SegmentHistory"]
    for parent in ["AttemptHistory/Attempt", "Segments/Segment/SplitTimes/SplitTime",
                   "Segments/Segment/BestSegmentTime", "Segments/Segment/SegmentHistory/Time"]:
        paths.extend(f"{parent}/{tag}" for tag in ["RealTime", "GameTime"])
    for path in paths:
        root = deepcopy(modern)
        parent_path, _, tag = path.rpartition("/")
        parent = next(p for p in root.findall(parent_path) if p.find(tag) is not None) if parent_path else root
        original = parent.find(tag)
        other = deepcopy(original)
        if tag in {"RealTime", "GameTime", "PauseTime"}:
            other.text = "00:09:59"
        if tag == "AttemptHistory":
            other.clear()  # distinct, empty second container, not a duplicate id
        parent.append(other)
        add(f"duplicate/{path}", root, error=f"Duplicate <{tag}>")

    for path in ["RunHistory", "Segments/Segment/PersonalBestSplitTime",
                 "Segments/Segment/BestSegmentTime"]:
        root = deepcopy(legacy)
        parent_path, _, tag = path.rpartition("/")
        parent = root.find(parent_path) if parent_path else root
        other = deepcopy(parent.find(tag))
        if tag == "RunHistory":
            other.clear()
        parent.append(other)
        add(f"legacy/duplicate-{tag}", root, error=f"Duplicate <{tag}>")

    for text, label in [("00:01:50.0000000", "identical"), (None, "empty")]:
        root = deepcopy(modern)
        ET.SubElement(root.find("AttemptHistory/Attempt"), "RealTime").text = text
        add(f"duplicate/RealTime-{label}", root, error="Duplicate <RealTime>")

    for path, tag in [("AttemptHistory", "Attempt"),
                      ("Segments/Segment/SegmentHistory", "Time"),
                      ("Segments/Segment/SplitTimes", "SplitTime")]:
        root = deepcopy(modern)
        ET.SubElement(root.find(path), tag)
        add(f"empty-record/{tag}", root, error=f"Invalid <{tag}> record")

    root = deepcopy(modern)
    del root.find("Segments/Segment/SplitTimes/SplitTime").attrib["name"]
    add("missing-comparison-name", root, error="missing its name attribute")
    root = deepcopy(modern)
    time = root.find("AttemptHistory/Attempt/RealTime")
    time.text = None
    ET.SubElement(time, "Value").text = "00:01:50.0000000"
    add("nested-time", root, error="expected text, not nested elements")
    for path in ["RunHistory/Time", "Segments/Segment/SegmentHistory/Time"]:
        root = deepcopy(legacy)
        time = root.find(path)
        ET.SubElement(time, "Value").text = time.text
        time.text = None
        add(f"legacy/nested-{path}", root, error="expected text, not nested elements")
    return rows


if __name__ == "__main__":
    import json
    for row in controls():
        print(json.dumps(row))
