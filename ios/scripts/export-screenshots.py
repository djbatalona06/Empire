#!/usr/bin/env python3
"""Copy UI-test screenshots out of an .xcresult and write a pass/fail summary.

Usage: export-screenshots.py TestResults.xcresult OUT_DIR
Writes OUT_DIR/<name>.png, OUT_DIR/results.json and prints a Markdown table (for $GITHUB_STEP_SUMMARY).
"""
import json, pathlib, re, shutil, subprocess, sys, tempfile

bundle, out = sys.argv[1], pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)

def xcresult(*args):
    return subprocess.run(["xcrun", "xcresulttool", *args, "--path", bundle], check=True, capture_output=True, text=True).stdout

# Screenshots: exported with UUID file names; the manifest maps them back to the names the tests gave them.
with tempfile.TemporaryDirectory() as tmp:
    xcresult("export", "attachments", "--output-path", tmp)
    manifest = json.loads(pathlib.Path(tmp, "manifest.json").read_text())
    for test in manifest:
        for a in test.get("attachments", []):
            name = re.sub(r"_\d+_[0-9A-F-]{36}", "", a["suggestedHumanReadableName"], flags=re.I)
            shutil.copy(pathlib.Path(tmp, a["exportedFileName"]), out / name)

# Per-test results
results = []
def walk(node):
    if node.get("nodeType") == "Test Case":
        failure = next((c["name"] for c in node.get("children", []) if c.get("nodeType") == "Failure Message"), "")
        results.append({"test": node["name"], "result": node.get("result", "Unknown"), "failure": failure})
    for child in node.get("children", []):
        walk(child)
for root in json.loads(xcresult("get", "test-results", "tests")).get("testNodes", []):
    walk(root)
(out / "results.json").write_text(json.dumps(results, indent=2))

print("| Test | Result | Why it failed |\n|---|---|---|")
for r in results:
    icon = "✅" if r["result"] == "Passed" else "❌"
    print(f"| {r['test']} | {icon} {r['result']} | {r['failure'].replace('|', '/')} |")
print(f"\n{len(list(out.glob('*.png')))} screenshots")
