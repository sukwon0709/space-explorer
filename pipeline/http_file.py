"""A read-only, seekable file over HTTP range requests, with a block cache.

Lets tifffile read a large remote GeoTIFF's directory and one reduced-resolution
overview without downloading the whole file.
"""

import io
import urllib.request

BLOCK = 1 << 20


class HttpFile(io.RawIOBase):
    def __init__(self, url: str):
        self.url = url
        self.pos = 0
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=120) as r:
            self.size = int(r.headers["Content-Length"])
        self.blocks: dict[int, bytes] = {}
        self.fetched = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def _block(self, i: int) -> bytes:
        if i not in self.blocks:
            start = i * BLOCK
            end = min(self.size, start + BLOCK) - 1
            req = urllib.request.Request(self.url, headers={"Range": f"bytes={start}-{end}"})
            for attempt in range(5):
                try:
                    with urllib.request.urlopen(req, timeout=300) as r:
                        self.blocks[i] = r.read()
                    break
                except OSError:
                    if attempt == 4:
                        raise
            self.fetched += len(self.blocks[i])
        return self.blocks[i]

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        n = max(0, min(n, self.size - self.pos))
        out = bytearray()
        while n > 0:
            i, off = divmod(self.pos, BLOCK)
            chunk = self._block(i)[off:off + n]
            out += chunk
            self.pos += len(chunk)
            n -= len(chunk)
        return bytes(out)

    def readinto(self, b):
        data = self.read(len(b))
        b[: len(data)] = data
        return len(data)
