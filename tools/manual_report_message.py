"""Build the publication message from the newest manual report links."""
import argparse
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin


class ReportLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_list = False
        self.current = None
        self.in_details = False
        self.links = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "ul" and "report-list" in attrs.get("class", "").split():
            self.in_list = True
        if self.in_list and tag == "a":
            self.current = [attrs.get("href", ""), []]
        if tag == "small":
            self.in_details = True

    def handle_data(self, data):
        if self.current is not None and not self.in_details:
            self.current[1].append(data)

    def handle_endtag(self, tag):
        if tag == "small":
            self.in_details = False
        if tag == "a" and self.current is not None:
            href, parts = self.current
            self.links.append((href, " ".join("".join(parts).split())))
            self.current = None
        if tag == "ul":
            self.in_list = False


def build_message(html, index_url):
    parser = ReportLinks()
    parser.feed(html)
    blocks = ["DiscoverCars | Nowe pliki"]
    blocks.extend(f"{title}\n{urljoin(index_url, href)}" for href, title in parser.links[:2])
    if not parser.links:
        blocks.append(f"Lista raportow:\n{index_url}")
    return "\n\n".join(blocks)


if __name__ == "__main__":
    args = argparse.ArgumentParser()
    args.add_argument("--index", required=True)
    args.add_argument("--url", required=True)
    config = args.parse_args()
    print(build_message(Path(config.index).read_text(encoding="utf-8"), config.url))
