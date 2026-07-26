from __future__ import annotations

import argparse
import json
import os

from .library import Library, watch_library
from .rpc import serve


def main() -> None:
    for name in ("no_proxy", "NO_PROXY"):
        if value := os.environ.get(name):
            os.environ[name] = ",".join(
                entry for entry in value.split(",") if not entry.strip().startswith("::")
            )
    parser = argparse.ArgumentParser(prog="p2i-engine")
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("rpc", help="Run newline-delimited JSON-RPC over stdin/stdout")
    initialize = subcommands.add_parser("init", help="Initialize a paper library")
    initialize.add_argument("root")
    scan = subcommands.add_parser("scan", help="Scan and parse a paper library once")
    scan.add_argument("root")
    watch = subcommands.add_parser("watch", help="Continuously scan a paper library")
    watch.add_argument("root")
    watch.add_argument("--interval", type=float, default=2.0)
    list_command = subcommands.add_parser("list", help="List persisted papers")
    list_command.add_argument("root")
    args = parser.parse_args()

    if args.command == "rpc":
        serve()
    elif args.command == "init":
        print(json.dumps(Library(args.root).initialize(), indent=2))
    elif args.command == "scan":
        print(json.dumps(Library(args.root).scan(), indent=2))
    elif args.command == "watch":
        watch_library(args.root, args.interval)
    elif args.command == "list":
        print(json.dumps(Library(args.root).list_papers(), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
