#!/usr/bin/env python3
"""
Wusool road-condition listener.

Community Telegram and WhatsApp groups are how Palestinians actually learn that
a checkpoint has closed — minutes before any official source, and often instead
of one. This process turns that chatter into structured road state by posting
each message to the Wusool API, which parses it and updates the live map.

Two modes:

  REPLAY (default, no credentials, no network beyond localhost)
      python3 listener.py --replay
      python3 listener.py --replay --delay 3     # paced, for a live demo

  LIVE (needs a Telegram API key and joined channels)
      export TELEGRAM_API_ID=... TELEGRAM_API_HASH=...
      export WUSOOL_CHANNELS="ahwal_altareeq,mrorpal"
      python3 listener.py --live

WHY REPLAY IS THE DEFAULT: a demo that depends on a third party posting a real
road update at the right moment is a demo that fails. Replay streams recorded
messages through the exact same endpoint the live listener uses, so what the
judges see is the real parser on real text — only the transport is stubbed.

The API does the language work. This file is deliberately dumb: it reads
messages and posts them. All the Arabic parsing, checkpoint matching and
freshness decay lives in the backend, so the live and replay paths cannot
drift apart.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = os.environ.get("WUSOOL_API", "http://localhost:4000/api")
HERE = Path(__file__).resolve().parent


def post_road(text: str, source: str = "telegram") -> dict | None:
    """Send one message to the ingest endpoint. Returns the parsed result."""
    body = json.dumps({"text": text, "source": source}).encode("utf-8")
    req = urllib.request.Request(
        f"{API}/ingest/road-post",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.URLError as e:
        print(f"  ! backend unreachable at {API}: {e}", file=sys.stderr)
        return None


def report(text: str, result: dict | None) -> None:
    short = text if len(text) <= 58 else text[:57] + "…"
    if result is None:
        print(f"  {short}\n      -> not delivered")
        return

    parsed = result.get("parsed", {})
    matched = result.get("matched", [])
    if not parsed.get("is_road_related"):
        print(f"  {short}\n      -> not road-related, ignored")
        return

    if not matched:
        print(f"  {short}\n      -> road-related but no known checkpoint named")
        return

    for m in matched:
        if m.get("matched"):
            print(f"  {short}\n      -> {m['matched']} = {m['status']}")
        else:
            # Worth surfacing: an unmatched place name is a checkpoint the
            # seed does not know about yet, which is a gap in the data.
            print(f"  {short}\n      -> unknown place \"{m['place']}\" (not in the checkpoint list)")


def wait_for_backend(tries: int = 10) -> bool:
    for i in range(tries):
        try:
            with urllib.request.urlopen(f"{API}/health", timeout=5) as r:
                h = json.loads(r.read().decode("utf-8"))
                print(f"backend up — parser: {h.get('llm')}, {h.get('checkpoints')} checkpoints\n")
                return True
        except urllib.error.URLError:
            if i == 0:
                print(f"waiting for backend at {API} …")
            time.sleep(2)
    print(f"backend never came up at {API}. Start it with: cd backend && npm run dev",
          file=sys.stderr)
    return False


def run_replay(delay: float, path: Path) -> None:
    if not path.exists():
        print(f"no sample file at {path}", file=sys.stderr)
        sys.exit(1)

    messages = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            messages.append(json.loads(line))

    print(f"replaying {len(messages)} recorded messages"
          f"{f' at {delay}s intervals' if delay else ''}\n")

    changed = 0
    for msg in messages:
        result = post_road(msg["text"], msg.get("src", "telegram"))
        report(msg["text"], result)
        if result and result.get("matched"):
            changed += sum(1 for m in result["matched"] if m.get("matched"))
        if delay:
            time.sleep(delay)

    print(f"\n{changed} checkpoint updates written to the live map.")
    print("open the dispatch dashboard to see them.")


def run_live(channels: list[str]) -> None:
    try:
        from telethon import TelegramClient, events  # type: ignore
    except ImportError:
        print("live mode needs Telethon:  pip install telethon", file=sys.stderr)
        sys.exit(1)

    api_id = os.environ.get("TELEGRAM_API_ID")
    api_hash = os.environ.get("TELEGRAM_API_HASH")
    if not api_id or not api_hash:
        print("set TELEGRAM_API_ID and TELEGRAM_API_HASH (get them at my.telegram.org)",
              file=sys.stderr)
        sys.exit(1)

    if not channels:
        print("set WUSOOL_CHANNELS to a comma-separated list of channels to follow",
              file=sys.stderr)
        sys.exit(1)

    client = TelegramClient(str(HERE / "wusool.session"), int(api_id), api_hash)
    print(f"listening to: {', '.join(channels)}")
    print("(only messages are read; nothing is ever sent)\n")

    @client.on(events.NewMessage(chats=channels))
    async def handler(event):  # noqa: ANN001
        text = (event.raw_text or "").strip()
        if not text:
            return
        report(text, post_road(text, "telegram"))

    client.start()
    client.run_until_disconnected()


def main() -> None:
    ap = argparse.ArgumentParser(description="Feed community road reports into Wusool.")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--replay", action="store_true",
                      help="stream recorded messages (default)")
    mode.add_argument("--live", action="store_true",
                      help="follow real Telegram channels")
    ap.add_argument("--delay", type=float, default=0.0,
                    help="seconds between replayed messages, for a paced demo")
    ap.add_argument("--file", type=Path, default=HERE / "samples.jsonl",
                    help="replay source (JSON lines with text and src)")
    args = ap.parse_args()

    if not wait_for_backend():
        sys.exit(1)

    if args.live:
        run_live([c.strip() for c in os.environ.get("WUSOOL_CHANNELS", "").split(",") if c.strip()])
    else:
        run_replay(args.delay, args.file)


if __name__ == "__main__":
    main()
