"""Convert a JPL SPK kernel (Chebyshev type 2) into the compact binary the app reads.

Usage:
    python pipeline/build_ephemeris.py KERNEL.bsp OUT.bin --start 1990-01-01 --end 2050-12-31

The output keeps JPL's own Chebyshev coefficients untouched; it only drops the
records outside the requested date range and the per-record MID/RADIUS words,
which the reader recomputes from INIT and INTLEN.

Layout (little-endian):
    header   : magic b"SEPH", u32 version, u32 segment count, u32 reserved
    segments : per segment 40 bytes
               i32 center, i32 target, f64 init (TDB s past J2000),
               f64 intlen (s), u32 ncoef, u32 nrec, u32 data offset, u32 reserved
    data     : per record 3 * ncoef f64 (x coefficients, y, z), km
"""

import argparse
import struct
from datetime import datetime, timezone

import numpy as np
from jplephem.spk import SPK

J2000 = datetime(2000, 1, 1, 12, tzinfo=timezone.utc)
MAGIC = b"SEPH"
VERSION = 1
HEADER = struct.Struct("<4sIII")
SEGMENT = struct.Struct("<iiddIIII")


def seconds_past_j2000(date: str) -> float:
    # Calendar dates are taken as TDB; the ~69 s TDB-UTC offset is irrelevant for range trimming.
    d = datetime.fromisoformat(date).replace(tzinfo=timezone.utc)
    return (d - J2000).total_seconds()


def read_type2(segment):
    """Return (init, intlen, coefficients[nrec, 3, ncoef]) straight from the DAF array."""
    if segment.data_type != 2:
        raise ValueError(f"segment {segment.center}->{segment.target} is type {segment.data_type}, expected 2")
    words = segment.daf.map_array(segment.start_i, segment.end_i)
    init, intlen, rsize, nrec = words[-4:]
    rsize, nrec = int(rsize), int(nrec)
    ncoef = (rsize - 2) // 3
    records = np.asarray(words[:-4]).reshape(nrec, rsize)
    return init, intlen, records[:, 2:].reshape(nrec, 3, ncoef)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("kernel")
    parser.add_argument("out")
    parser.add_argument("--start", default="1990-01-01")
    parser.add_argument("--end", default="2050-12-31")
    args = parser.parse_args()

    t0, t1 = seconds_past_j2000(args.start), seconds_past_j2000(args.end)
    kernel = SPK.open(args.kernel)

    segments = []
    for seg in kernel.segments:
        init, intlen, coef = read_type2(seg)
        first = max(0, int((t0 - init) // intlen))
        last = min(len(coef), int(np.ceil((t1 - init) / intlen)))
        if last <= first:
            raise ValueError(f"segment {seg.center}->{seg.target} does not cover {args.start}..{args.end}")
        segments.append((seg.center, seg.target, init + first * intlen, intlen, coef[first:last]))

    offset = HEADER.size + SEGMENT.size * len(segments)
    offset += -offset % 8
    with open(args.out, "wb") as f:
        f.write(HEADER.pack(MAGIC, VERSION, len(segments), 0))
        data_offsets = []
        for center, target, init, intlen, coef in segments:
            nrec, _, ncoef = coef.shape
            f.write(SEGMENT.pack(center, target, init, intlen, ncoef, nrec, offset, 0))
            data_offsets.append(offset)
            offset += coef.nbytes
        f.write(b"\0" * (data_offsets[0] - f.tell()))
        for (*_, coef), at in zip(segments, data_offsets):
            assert f.tell() == at
            f.write(np.ascontiguousarray(coef, dtype="<f8").tobytes())

    print(f"wrote {args.out}: {len(segments)} segments, {offset / 1e6:.1f} MB, {args.start}..{args.end}")


if __name__ == "__main__":
    main()
