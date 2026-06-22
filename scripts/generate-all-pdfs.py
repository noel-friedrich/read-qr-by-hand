#!/usr/bin/env python3
"""Generate printable PDFs for the tutorial and supported QR worksheet variants."""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path


ECC_LEVELS = ("L", "M", "Q", "H")
MASKS = tuple(range(8))
VERSIONS = tuple(range(1, 6))
TOTAL_PDFS = len(VERSIONS) * len(ECC_LEVELS) * len(MASKS)


class BrowserNotFoundError(RuntimeError):
    pass


class DevToolsError(RuntimeError):
    pass


class WebSocket:
    def __init__(self, url: str, timeout: float) -> None:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "ws":
            raise ValueError(f"Only ws:// URLs are supported, got {url!r}")

        self.socket = socket.create_connection((parsed.hostname, parsed.port), timeout=timeout)
        self.socket.settimeout(timeout)

        key = base64.b64encode(os.urandom(16)).decode("ascii")
        path = parsed.path
        if parsed.query:
            path = f"{path}?{parsed.query}"

        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {parsed.netloc}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        self.socket.sendall(request.encode("ascii"))
        response = self._read_until(b"\r\n\r\n")
        if b" 101 " not in response.split(b"\r\n", 1)[0]:
            raise DevToolsError(f"WebSocket upgrade failed: {response[:200]!r}")

    def close(self) -> None:
        try:
            self.socket.close()
        except OSError:
            pass

    def send_text(self, payload: str) -> None:
        data = payload.encode("utf-8")
        header = bytearray([0x81])

        if len(data) < 126:
            header.append(0x80 | len(data))
        elif len(data) < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", len(data)))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", len(data)))

        mask = os.urandom(4)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(data))
        self.socket.sendall(bytes(header) + mask + masked)

    def recv_text(self) -> str:
        chunks: list[bytes] = []

        while True:
            first_two = self._read_exactly(2)
            first, second = first_two
            fin = bool(first & 0x80)
            opcode = first & 0x0F
            is_masked = bool(second & 0x80)
            length = second & 0x7F

            if length == 126:
                length = struct.unpack("!H", self._read_exactly(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read_exactly(8))[0]

            mask = self._read_exactly(4) if is_masked else None
            payload = self._read_exactly(length) if length else b""
            if mask:
                payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))

            if opcode == 0x8:
                raise DevToolsError("Browser closed the DevTools WebSocket")
            if opcode == 0x9:
                self._send_control_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode not in (0x0, 0x1, 0x2):
                continue

            chunks.append(payload)
            if fin:
                return b"".join(chunks).decode("utf-8")

    def _send_control_frame(self, opcode: int, payload: bytes) -> None:
        if len(payload) > 125:
            payload = payload[:125]

        mask = os.urandom(4)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.socket.sendall(bytes([0x80 | opcode, 0x80 | len(payload)]) + mask + masked)

    def _read_until(self, delimiter: bytes) -> bytes:
        buffer = bytearray()
        while delimiter not in buffer:
            chunk = self.socket.recv(4096)
            if not chunk:
                raise DevToolsError("Socket closed while reading")
            buffer.extend(chunk)
        return bytes(buffer)

    def _read_exactly(self, size: int) -> bytes:
        buffer = bytearray()
        while len(buffer) < size:
            chunk = self.socket.recv(size - len(buffer))
            if not chunk:
                raise DevToolsError("Socket closed while reading")
            buffer.extend(chunk)
        return bytes(buffer)


class DevToolsPage:
    def __init__(self, websocket_url: str, timeout: float) -> None:
        self.websocket = WebSocket(websocket_url, timeout)
        self.timeout = timeout
        self.next_id = 1
        self.events: list[dict] = []
        self.send("Page.enable")
        self.send("Runtime.enable")

    def close(self) -> None:
        self.websocket.close()

    def send(self, method: str, params: dict | None = None) -> dict:
        message_id = self.next_id
        self.next_id += 1

        payload = {"id": message_id, "method": method}
        if params is not None:
            payload["params"] = params

        self.websocket.send_text(json.dumps(payload, separators=(",", ":")))

        while True:
            message = json.loads(self.websocket.recv_text())
            if message.get("id") == message_id:
                if "error" in message:
                    error = message["error"]
                    raise DevToolsError(f"{method} failed: {error.get('message', error)}")
                return message.get("result", {})
            if "method" in message:
                self.events.append(message)

    def wait_for_event(self, method: str) -> dict:
        deadline = time.monotonic() + self.timeout

        for index, event in enumerate(self.events):
            if event.get("method") == method:
                return self.events.pop(index)

        while time.monotonic() < deadline:
            try:
                message = json.loads(self.websocket.recv_text())
            except socket.timeout:
                continue

            if message.get("method") == method:
                return message
            if "method" in message:
                self.events.append(message)

        raise TimeoutError(f"Timed out waiting for DevTools event {method!r}")


def find_browser(explicit_path: str | None = None) -> str:
    candidates: list[str] = []

    if explicit_path:
        candidates.append(explicit_path)

    for env_name in ("CHROME", "CHROMIUM", "BROWSER"):
        env_value = os.environ.get(env_name)
        if env_value:
            candidates.append(env_value)

    for executable in (
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
        "chrome",
        "msedge",
        "microsoft-edge",
    ):
        found = shutil.which(executable)
        if found:
            candidates.append(found)

    if sys.platform == "win32":
        roots = [
            os.environ.get("PROGRAMFILES"),
            os.environ.get("PROGRAMFILES(X86)"),
            os.environ.get("LOCALAPPDATA"),
        ]
        relative_paths = [
            ("Google", "Chrome", "Application", "chrome.exe"),
            ("Chromium", "Application", "chrome.exe"),
            ("Microsoft", "Edge", "Application", "msedge.exe"),
        ]
        for root in roots:
            if not root:
                continue
            for relative_path in relative_paths:
                candidates.append(str(Path(root, *relative_path)))
    elif sys.platform == "darwin":
        candidates.extend(
            [
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            ]
        )

    for candidate in candidates:
        path = Path(candidate).expanduser()
        if path.is_file():
            return str(path)

    raise BrowserNotFoundError(
        "Could not find Chrome, Chromium, or Edge. Pass --browser PATH or set CHROME."
    )


def start_browser(browser_path: str, user_data_dir: Path) -> subprocess.Popen:
    command = [
        browser_path,
        "--headless=new",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--no-default-browser-check",
        "--no-first-run",
        "--remote-debugging-port=0",
        f"--user-data-dir={user_data_dir}",
        "about:blank",
    ]

    return subprocess.Popen(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def wait_for_devtools_port(user_data_dir: Path, timeout: float) -> int:
    port_file = user_data_dir / "DevToolsActivePort"
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        if port_file.exists():
            lines = port_file.read_text(encoding="utf-8").splitlines()
            if lines:
                return int(lines[0])
        time.sleep(0.05)

    raise TimeoutError("Timed out waiting for Chromium to start DevTools")


def create_page(port: int, timeout: float) -> tuple[str, str]:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/json/new?about:blank",
        method="PUT",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        target = json.loads(response.read().decode("utf-8"))

    return target["id"], target["webSocketDebuggerUrl"]


def close_page(port: int, target_id: str, timeout: float) -> None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/close/{target_id}", timeout=timeout):
            pass
    except Exception:
        pass


def variant_url(index_file: Path, version: int, ecc_level: str, mask: int) -> str:
    params = urllib.parse.urlencode({"v": version, "e": ecc_level, "m": mask})
    return f"{index_file.as_uri()}?{params}"


def render_ready_expression(expected_name: str, worksheet_only: bool) -> str:
    worksheet_only_json = json.dumps(worksheet_only)
    return f"""
        new Promise((resolve, reject) => {{
            const finish = () => requestAnimationFrame(() => requestAnimationFrame(() => {{
                const output = document.querySelector("#version-name-output")?.textContent?.trim();
                const pageCount = document.querySelectorAll("main.main-container > .page").length;
                if (output !== {json.dumps(expected_name)}) {{
                    reject(new Error(`Expected {expected_name}, got ${{output}}`));
                    return;
                }}
                if (typeof isPrintingWorksheetOnly !== "undefined") {{
                    isPrintingWorksheetOnly = {worksheet_only_json};
                }}
                document.body.classList.toggle("print-worksheet-only", {worksheet_only_json});
                if (typeof updatePrintLayout === "function") {{
                    updatePrintLayout();
                }}
                requestAnimationFrame(() => resolve({{
                    output,
                    pageCount,
                    worksheetOnly: document.body.classList.contains("print-worksheet-only")
                }}));
            }}));

            if (document.readyState === "complete") {{
                finish();
            }} else {{
                window.addEventListener("load", finish, {{ once: true }});
            }}
        }})
    """


def print_pdf(
    page: DevToolsPage,
    url: str,
    output_path: Path,
    expected_name: str,
    *,
    worksheet_only: bool,
) -> None:
    page.events.clear()
    page.send("Page.navigate", {"url": url})
    page.wait_for_event("Page.loadEventFired")
    render_result = page.send(
        "Runtime.evaluate",
        {
            "expression": render_ready_expression(expected_name, worksheet_only),
            "awaitPromise": True,
            "returnByValue": True,
        },
    )
    if "exceptionDetails" in render_result:
        details = render_result["exceptionDetails"]
        message = details.get("text", "Render readiness check failed")
        exception = details.get("exception", {})
        if "description" in exception:
            message = exception["description"]
        raise DevToolsError(message)

    result = page.send(
        "Page.printToPDF",
        {
            "displayHeaderFooter": False,
            "printBackground": True,
            "preferCSSPageSize": True,
            "marginTop": 0,
            "marginRight": 0,
            "marginBottom": 0,
            "marginLeft": 0,
        },
    )
    output_path.write_bytes(base64.b64decode(result["data"]))


def progress_line(done: int, total: int, label: str) -> str:
    width = 32
    filled = round(width * done / total)
    bar = "#" * filled + "-" * (width - filled)
    return f"\r[{bar}] {done:3d}/{total} {done / total:6.1%} {label:<12}"


def generate_pdfs(args: argparse.Namespace) -> None:
    repo_root = Path(__file__).resolve().parents[1]
    index_file = repo_root / "index.html"
    output_dir = Path(args.output_dir).resolve() if args.output_dir else repo_root / "pdfs"
    output_dir.mkdir(parents=True, exist_ok=True)

    browser_path = find_browser(args.browser)
    print(f"Using browser: {browser_path}")
    print(f"Writing PDFs to: {output_dir}")

    variants = [
        (version, ecc_level, mask)
        for version in VERSIONS
        for ecc_level in ECC_LEVELS
        for mask in MASKS
    ]
    if args.limit is not None:
        variants = variants[: args.limit]

    if args.dry_run:
        for version, ecc_level, mask in variants:
            name = f"V{version}{ecc_level}{mask}"
            print(output_dir / f"full-{name}.pdf")
            print(output_dir / f"{name}.pdf")
        print(f"Dry run: {len(variants)} full PDFs and {len(variants)} worksheet PDFs listed.")
        return

    with tempfile.TemporaryDirectory(prefix="qr-pdf-browser-", ignore_cleanup_errors=True) as profile_dir:
        browser = start_browser(browser_path, Path(profile_dir))
        target_id = None
        page = None

        try:
            port = wait_for_devtools_port(Path(profile_dir), args.timeout)
            target_id, websocket_url = create_page(port, args.timeout)
            page = DevToolsPage(websocket_url, args.timeout)
            page.send("Emulation.setEmulatedMedia", {"media": "print"})

            total_jobs = len(variants) * 2

            for index, (version, ecc_level, mask) in enumerate(variants):
                name = f"V{version}{ecc_level}{mask}"
                full_job_index = index * 2 + 1
                worksheet_job_index = full_job_index + 1

                print(progress_line(full_job_index - 1, total_jobs, f"full-{name}"), end="", flush=True)
                print_pdf(
                    page,
                    variant_url(index_file, version, ecc_level, mask),
                    output_dir / f"full-{name}.pdf",
                    name,
                    worksheet_only=False,
                )
                print(progress_line(full_job_index, total_jobs, f"full-{name}"), end="", flush=True)

                print(progress_line(worksheet_job_index - 1, total_jobs, name), end="", flush=True)
                print_pdf(
                    page,
                    variant_url(index_file, version, ecc_level, mask),
                    output_dir / f"{name}.pdf",
                    name,
                    worksheet_only=True,
                )
                print(progress_line(worksheet_job_index, total_jobs, name), end="", flush=True)

            print()
        finally:
            if page:
                page.close()
            if target_id:
                close_page(port, target_id, args.timeout)
            browser.terminate()
            try:
                browser.wait(timeout=5)
            except subprocess.TimeoutExpired:
                browser.kill()
                browser.wait(timeout=5)

    print(f"Done. Created {len(variants) * 2} PDF files.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export all QR tutorial PDF variants into the pdfs/ directory."
    )
    parser.add_argument(
        "--browser",
        help="Path to a Chrome, Chromium, or Edge executable. Defaults to auto-detection.",
    )
    parser.add_argument(
        "--output-dir",
        help="Directory for generated PDFs. Defaults to ./pdfs.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=30.0,
        help="Browser/page timeout in seconds. Default: 30.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List the PDF filenames that would be generated without launching Chromium.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="Generate only the first N variants. Useful for smoke tests.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        generate_pdfs(args)
    except KeyboardInterrupt:
        print("\nCancelled.", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"\nError: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
