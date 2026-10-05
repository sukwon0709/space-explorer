"""Read SPK (DAF) kernels over HTTP range requests, fetching only the bytes needed.

NAIF's satellite kernels are 0.1 to 2 GB each but cover centuries; the app needs a
century of a few bodies. This reads the file record, the summary records and then only
the Chebyshev records inside the requested time span. Fetched byte ranges are cached
on disk, so re-runs are offline.
"""

import hashlib
import os
import struct
import urllib.request

import numpy as np

RECORD = 1024


class RemoteSPK:
    def __init__(self, url: str, cache_dir: str):
        self.url = url
        self.cache_dir = cache_dir
        os.makedirs(cache_dir, exist_ok=True)
        head = self.read(0, RECORD)
        if not head.startswith(b"DAF/SPK"):
            raise ValueError(f"{url} is not an SPK file")
        if head[88:96] != b"LTL-IEEE":
            raise ValueError("only little-endian kernels are supported")
        nd, ni = struct.unpack_from("<ii", head, 8)
        fward, = struct.unpack_from("<i", head, 76)
        self.nd, self.ni = nd, ni
        self.segments = []
        record = fward
        size = nd + (ni + 1) // 2
        while record:
            data = self.read((record - 1) * RECORD, RECORD)
            nxt, _, nsum = struct.unpack_from("<ddd", data, 0)
            for i in range(int(nsum)):
                at = 24 + i * size * 8
                start, end = struct.unpack_from("<dd", data, at)
                target, center, frame, kind, first, last = struct.unpack_from("<6i", data, at + 16)
                self.segments.append(dict(start=start, end=end, target=target, center=center, frame=frame, type=kind, first=first, last=last))
            record = int(nxt)

    def read(self, offset: int, length: int) -> bytes:
        key = hashlib.sha1(f"{self.url}:{offset}:{length}".encode()).hexdigest()
        path = os.path.join(self.cache_dir, key)
        if os.path.exists(path):
            with open(path, "rb") as f:
                return f.read()
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={offset}-{offset + length - 1}"})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=600) as r:
                    data = r.read()
                break
            except OSError:
                if attempt == 3:
                    raise
        if len(data) != length:
            raise IOError(f"short read from {self.url}: {len(data)} of {length}")
        with open(path + ".part", "wb") as f:
            f.write(data)
        os.replace(path + ".part", path)
        return data

    def words(self, first: int, count: int) -> np.ndarray:
        """`count` float64 words from 1-based DAF address `first`."""
        return np.frombuffer(self.read((first - 1) * 8, count * 8), dtype="<f8")

    def chebyshev(self, target: int, t0: float, t1: float):
        """Position records covering t0..t1, possibly from several segments.

        Returns (center, pieces) with pieces a list of (start, end, init, intlen,
        coef[nrec, 3, ncoef]) in time order. Type 2 and type 3 segments (type 3's
        velocity coefficients are dropped).
        """
        pieces = []
        center = None
        for seg in self.segments:
            if seg["target"] != target or seg["end"] <= t0 or seg["start"] >= t1:
                continue
            if seg["type"] not in (2, 3):
                raise ValueError(f"body {target}: SPK type {seg['type']} not supported")
            center = seg["center"]
            a, b = max(t0, seg["start"]), min(t1, seg["end"])
            init, intlen, rsize, n = self.words(seg["last"] - 3, 4)
            rsize, n = int(rsize), int(n)
            sets = 3 if seg["type"] == 2 else 6
            ncoef = (rsize - 2) // sets
            i0 = max(0, int((a - init) // intlen))
            i1 = min(n, int(np.ceil((b - init) / intlen)))
            recs = self.words(seg["first"] + i0 * rsize, (i1 - i0) * rsize).reshape(i1 - i0, rsize)
            coef = recs[:, 2:2 + 3 * ncoef].reshape(i1 - i0, 3, ncoef)
            pieces.append((a, b, init + i0 * intlen, intlen, coef))
        pieces.sort(key=lambda p: p[0])
        if not pieces or pieces[0][0] > t0 or pieces[-1][1] < t1:
            raise ValueError(f"no segments for body {target} covering the span in {self.url}")
        return center, pieces

    def segment_info(self, target: int):
        for seg in self.segments:
            if seg["target"] == target:
                init, intlen, rsize, n = self.words(seg["last"] - 3, 4)
                return seg, intlen, int(rsize)
        return None
