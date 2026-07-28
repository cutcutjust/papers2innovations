import sys

from p2i_engine.__main__ import main


def configure_rpc_streams() -> None:
    """Keep JSON-RPC input and output independent of the Windows code page."""
    for stream in (sys.stdin, sys.stdout):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="strict")


if __name__ == "__main__":
    configure_rpc_streams()
    main()
