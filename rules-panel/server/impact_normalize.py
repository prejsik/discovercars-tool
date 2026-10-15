"""Stream a published final JSON with the standard JSON decoder, preserving full decisions."""
import hashlib
import json
import sys
from pathlib import Path


class JsonStream:
    def __init__(self, handle):
        self.handle = handle
        self.buffer = ""
        self.eof = False
        self.decoder = json.JSONDecoder()

    def fill(self):
        chunk = self.handle.read(65536)
        self.eof = not chunk
        self.buffer += chunk
        if len(self.buffer) > 8 * 1024 * 1024:
            raise ValueError("Oversized JSON item")

    def peek(self):
        self.buffer = self.buffer.lstrip()
        while not self.buffer and not self.eof:
            self.fill()
            self.buffer = self.buffer.lstrip()
        return self.buffer[:1]

    def expect(self, token):
        if self.peek() != token:
            raise ValueError("Invalid JSON structure")
        self.buffer = self.buffer[1:]

    def value(self):
        self.peek()
        while True:
            try:
                value, end = self.decoder.raw_decode(self.buffer)
                if end == len(self.buffer) and not self.eof:
                    self.fill()
                    continue
                if end < len(self.buffer) and self.buffer[end] not in " \r\n\t,:}]":
                    raise ValueError("Invalid JSON delimiter")
                self.buffer = self.buffer[end:]
                return value
            except json.JSONDecodeError:
                if self.eof:
                    raise
                self.fill()

    def array(self, consume):
        self.expect("[")
        count = 0
        while self.peek() != "]":
            if count:
                self.expect(",")
            consume(self.value())
            count += 1
            if count > 100000:
                raise ValueError("Oversized decision scope")
        self.expect("]")


def normalize(source, target):
    digest = hashlib.sha256()
    with source.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    metadata = {}
    decision_hashes = {}
    recommendation_hashes = {}
    seen = set()
    first = True
    key_of = lambda item: (item["location"], item["start_date"], item["rental_days"])
    fingerprint = lambda item: hashlib.sha256(json.dumps(item, sort_keys=True, ensure_ascii=False,
                                                       separators=(",", ":")).encode()).hexdigest()
    with source.open("r", encoding="utf-8") as handle, target.open("w", encoding="utf-8") as output:
        reader = JsonStream(handle)
        output.write('{"decisions":[')

        def decision(item):
            nonlocal first
            key = key_of(item)
            if key in decision_hashes:
                raise ValueError("Duplicate decision")
            decision_hashes[key] = fingerprint(item)
            if not first:
                output.write(",")
            json.dump(item, output, ensure_ascii=False, separators=(",", ":"))
            first = False

        def recommendation(item):
            key = key_of(item)
            if key in recommendation_hashes:
                raise ValueError("Duplicate recommendation")
            recommendation_hashes[key] = fingerprint(item)

        reader.expect("{")
        while reader.peek() != "}":
            if seen:
                reader.expect(",")
            name = reader.value()
            if not isinstance(name, str) or name in seen:
                raise ValueError("Duplicate or invalid JSON key")
            seen.add(name)
            reader.expect(":")
            if name == "decisions":
                reader.array(decision)
            elif name == "recommendations":
                reader.array(recommendation)
            else:
                value = reader.value()
                if name in {"source_generated_at", "generated_at", "options", "recommendation_count", "skipped_count"}:
                    metadata[name] = value
        reader.expect("}")
        if reader.peek() or not {"decisions", "recommendations"} <= seen:
            raise ValueError("Incomplete JSON document")
        if any(decision_hashes.get(key) != value for key, value in recommendation_hashes.items()):
            raise ValueError("Inconsistent recommendations")
        metadata["recommendationKeys"] = list(recommendation_hashes)
        metadata["normalization"] = {"originalSha256": digest.hexdigest(), "originalBytes": source.stat().st_size,
                                     "decisions": len(decision_hashes), "recommendations": len(recommendation_hashes)}
        output.write("]")
        for name, value in metadata.items():
            output.write("," + json.dumps(name) + ":")
            json.dump(value, output, ensure_ascii=False, separators=(",", ":"))
        output.write("}")
    return metadata["normalization"]


if __name__ == "__main__":
    try:
        print(json.dumps(normalize(Path(sys.argv[1]), Path(sys.argv[2]))))
    except Exception:
        print(json.dumps({"error": "Published final JSON failed structural or duplicate-evidence validation."}))
        sys.exit(1)
