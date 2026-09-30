#!/usr/bin/env python3
"""
Hand the app's own QR codes to a real reader and check they come back.

The tests in qr.test.js check the squares are in the right places. This checks
the thing that actually matters: that a scanner reads them. It uses zxing-cpp,
the decoder behind most phone and scanner software — code written here, read by
something entirely unrelated.

This is a developer check, not part of the shop's install: it needs Python and
two packages, neither of which goes anywhere near the shop computer.

    pip install zxing-cpp pillow numpy
    python3 tests/app/decode-qr.py
"""

import json
import subprocess
import sys
from pathlib import Path

try:
    import numpy as np
    import zxingcpp
    from PIL import Image
except ImportError:
    sys.exit("Needs: pip install zxing-cpp pillow numpy")

HERE = Path(__file__).resolve().parent
QR = HERE.parent.parent / "apps" / "shop" / "qr.js"

# A spread of real label codes, plus the awkward cases: every correction level,
# every encoding mode, and lengths that push the code up a size.
GENERATE = """
import { matrix } from %s;
const cases = [];
for (const level of ['L','M','Q','H']) {
  for (const text of ['SNM-B1-7', 'SNM-B7423-K', 'SNM-B999999-2',
                      '1234567890', 'HELLO WORLD $%%*+-./:',
                      'Dolo 650 batch B4471 exp 03/2028',
                      'paracetamol 650mg \\u20b933.10',
                      'A'.repeat(40), 'z'.repeat(90)]) {
    cases.push({ text, level, grid: matrix(text, { level }) });
  }
}
console.log(JSON.stringify(cases));
""" % json.dumps(str(QR))


def image_for(grid, scale=8, quiet=4):
    g = np.array(grid, dtype=np.uint8)
    h, w = g.shape
    page = np.ones((h + 2 * quiet, w + 2 * quiet), dtype=np.uint8)
    page[quiet:quiet + h, quiet:quiet + w] = 1 - g        # 1 = white, 0 = black
    return Image.fromarray(np.kron(page * 255, np.ones((scale, scale), dtype=np.uint8)))


def main():
    out = subprocess.run([sys.executable and "node", "--input-type=module", "-e", GENERATE],
                         capture_output=True, text=True)
    if out.returncode:
        sys.exit(f"could not generate the codes:\n{out.stderr}")
    cases = json.loads(out.stdout)

    failed = 0
    for case in cases:
        found = zxingcpp.read_barcode(image_for(case["grid"]))
        got = found.text if found else ""
        size = len(case["grid"])
        if got != case["text"]:
            failed += 1
            print(f"FAIL  {case['level']}  v{(size - 17) // 4}  "
                  f"{case['text'][:38]!r}\n        read back: {got[:38]!r}")

    print(f"\n{len(cases) - failed} of {len(cases)} codes read correctly.")
    if failed:
        sys.exit(f"{failed} could not be read — do not print labels from this build.")
    print("Every code the app prints can be scanned.")


if __name__ == "__main__":
    main()
