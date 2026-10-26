#!/usr/bin/env python3
"""Gather Android UI-test screenshots and JUnit results after `connectedDebugAndroidTest`.

Usage: collect-results.py ANDROID_DIR OUT_DIR
Writes OUT_DIR/<name>.png, OUT_DIR/results.json and prints a Markdown table (for $GITHUB_STEP_SUMMARY).
"""
import json, pathlib, shutil, sys, xml.etree.ElementTree as ET

android, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
outputs = android / "app/build/outputs"

for png in (outputs / "connected_android_test_additional_output").rglob("*.png"):
    shutil.copy(png, out / png.name)

results = []
for report in (outputs / "androidTest-results/connected").rglob("TEST-*.xml"):
    for case in ET.parse(report).getroot().iter("testcase"):
        failure = case.find("failure")
        if failure is None:
            failure = case.find("error")
        skipped = case.find("skipped") is not None
        results.append({
            "test": case.get("name"),
            "result": "Skipped" if skipped else ("Failed" if failure is not None else "Passed"),
            "failure": (failure.get("message") or failure.text or "").strip().splitlines()[0][:300] if failure is not None else "",
        })
(out / "results.json").write_text(json.dumps(results, indent=2))

print("| Test | Result | Why it failed |\n|---|---|---|")
for r in results:
    icon = "✅" if r["result"] == "Passed" else ("⏭️" if r["result"] == "Skipped" else "❌")
    print(f"| {r['test']} | {icon} {r['result']} | {r['failure'].replace('|', '/')} |")
print(f"\n{len(list(out.glob('*.png')))} screenshots")
