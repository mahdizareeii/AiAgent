"""PyInstaller entry point; runtime tools never execute shell commands."""

import sys

if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--pdf-worker":
        from local_agent_research.pdf_worker import main
    else:
        from local_agent_research.server import main
    main()
