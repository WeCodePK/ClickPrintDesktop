#!/usr/bin/env python3
"""Generate a Windows .ico from a square PNG logo.

electron-builder's Windows/NSIS target rejects any icon that doesn't carry a
256x256 image, so the app icon can't just be the small favicon-sized .ico that
image exporters tend to hand you. This regenerates assets/icon.ico from the
512x512 source art at the size(s) Windows actually wants.

Requires Pillow:  pip install pillow

    python scripts/png-to-ico.py assets/icon.png assets/icon.ico
    python scripts/png-to-ico.py assets/icon.png assets/icon.ico --sizes 16,32,48,256
"""

import argparse
import sys
from pathlib import Path

from PIL import Image


def parse_sizes(raw):
	sizes = sorted({int(part) for part in raw.split(",") if part.strip()})
	for size in sizes:
		if not 1 <= size <= 256:
			raise argparse.ArgumentTypeError(f"icon size out of range (1-256): {size}")
	if not sizes:
		raise argparse.ArgumentTypeError("no sizes given")
	return sizes


def main():
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("src", type=Path, help="source PNG (square, ideally 512x512 or larger)")
	parser.add_argument("dst", type=Path, help="destination .ico")
	parser.add_argument(
		"--sizes",
		type=parse_sizes,
		default=[256],
		help="comma-separated square sizes to embed (default: 256)",
	)
	args = parser.parse_args()

	# RGBA keeps the logo's transparency; without it Pillow flattens onto black.
	image = Image.open(args.src).convert("RGBA")

	if image.width != image.height:
		print(f"warning: {args.src} is {image.width}x{image.height}, not square — Windows will letterbox it", file=sys.stderr)

	largest = max(args.sizes)
	if max(image.size) < largest:
		print(f"warning: upscaling {max(image.size)}px source to {largest}px will look soft", file=sys.stderr)

	# Pillow downsamples each requested size off the source itself, so hand it
	# the full-resolution image and let LANCZOS do the work.
	args.dst.parent.mkdir(parents=True, exist_ok=True)
	image.save(args.dst, format="ICO", sizes=[(s, s) for s in args.sizes])

	print(f"wrote {args.dst} ({args.dst.stat().st_size:,} bytes) containing: " + ", ".join(f"{s}x{s}" for s in args.sizes))


if __name__ == "__main__":
	main()
