#!/usr/bin/env python3
"""
Fake RAW/JetDirect printers with manual per-job control.

Listens on several TCP ports at once (one per fake printer). Each incoming
print job is parked mid-transfer and waits for you to decide its fate from
the console.

Usage:  python fakeprinters.py
Type 'help' at the prompt for commands.
"""

import itertools
import random
import socket
import struct
import sys
import threading
import time

# ---------------------------------------------------------------- config

PRINTERS = {
    "FakeA": 9100,
    "FakeB": 9101,
    "FakeC": 9102,
}

PREVIEW_BYTES = 512          # how much we read before parking the job
PREVIEW_TIMEOUT = 5.0        # seconds to wait for the first bytes
DRAIN_TIMEOUT = 30.0         # seconds to wait while draining an accepted job

# ---------------------------------------------------------------- state

_lock = threading.Lock()
_job_ids = itertools.count(1)
JOBS = {}       # job id -> Job
PRINTERS_STATE = {}  # printer name -> Printer


def note(msg):
    """Thread-safe console notice that doesn't eat the prompt."""
    sys.stdout.write("\r" + msg + "\n> ")
    sys.stdout.flush()


class Job:
    def __init__(self, jid, printer, conn, preview):
        self.id = jid
        self.printer = printer
        self.conn = conn
        self.preview = preview
        self.bytes_seen = len(preview)
        self.created = time.time()
        self.state = "PENDING"
        self.decision = None      # "ok" | "fail" | "hang"
        self.delay = 0.0
        self.event = threading.Event()

    def resolve(self, decision, delay=0.0):
        if self.event.is_set():
            return False
        self.decision = decision
        self.delay = delay
        self.event.set()
        return True

    def age(self):
        return time.time() - self.created


class Printer:
    def __init__(self, name, port):
        self.name = name
        self.port = port
        self.mode = "manual"      # manual | auto
        self.fail_rate = 0.3
        self.online = False
        self.sock = None
        self.thread = None

    def start(self):
        if self.online:
            return
        s = socket.socket()
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", self.port))
        s.listen(8)
        self.sock = s
        self.online = True
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def stop(self):
        """Going offline = closing the listener, so the spooler gets
        connection-refused, which is a different app code path from a
        job that errors mid-print."""
        if not self.online:
            return
        self.online = False
        try:
            self.sock.close()
        except OSError:
            pass

    def _serve(self):
        while self.online:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                break
            threading.Thread(
                target=self._handle, args=(conn,), daemon=True
            ).start()

    def _handle(self, conn):
        jid = next(_job_ids)

        # Read a small preview so there's something to show the operator,
        # but deliberately stop short of EOF: the spooler is still writing,
        # which keeps a reset meaningful as a mid-job failure.
        conn.settimeout(PREVIEW_TIMEOUT)
        try:
            preview = conn.recv(PREVIEW_BYTES)
        except (socket.timeout, OSError):
            preview = b""
        conn.settimeout(None)

        job = Job(jid, self, conn, preview)
        with _lock:
            JOBS[jid] = job

        note(f"[job {jid}] {self.name}: incoming ({len(preview)} bytes seen)")

        if self.mode == "auto":
            time.sleep(random.uniform(0.2, 2.0))
            job.resolve("fail" if random.random() < self.fail_rate else "ok")

        job.event.wait()

        if job.decision == "ok":
            self._accept_job(job)
        elif job.decision == "hang":
            job.state = "HUNG"
            note(f"[job {jid}] {self.name}: holding the line "
                 f"for {job.delay:.0f}s")
            time.sleep(job.delay)
            self._reset(job, "TIMED-OUT")
        else:
            self._reset(job, "FAILED")

    def _accept_job(self, job):
        job.state = "PRINTING"
        conn = job.conn
        conn.settimeout(DRAIN_TIMEOUT)
        try:
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                job.bytes_seen += len(chunk)
        except (socket.timeout, OSError):
            pass
        if job.delay:
            time.sleep(job.delay)
        try:
            conn.close()          # graceful FIN -> spooler marks it printed
        except OSError:
            pass
        job.state = "PRINTED"
        note(f"[job {job.id}] {self.name}: PRINTED "
             f"({job.bytes_seen} bytes)")

    def _reset(self, job, label):
        try:
            # linger on, timeout 0 -> RST instead of FIN
            job.conn.setsockopt(
                socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0)
            )
            job.conn.close()
        except OSError:
            pass
        job.state = label
        note(f"[job {job.id}] {self.name}: {label}")


# ---------------------------------------------------------------- console

HELP = """
  ls                      list printers
  jobs                    list jobs still waiting on you
  ok    <id|all> [sec]    accept the job, optionally after a delay
  fail  <id|all>          reset the connection mid-job
  hang  <id|all> [sec]    hold the line, then reset (default 60s)
  auto  <printer> [rate]  auto-decide jobs, rate = failure probability
  manual <printer>        back to waiting on you
  offline <printer>       close the listener (connection refused)
  online  <printer>       reopen the listener
  quit
"""


def cmd_ls():
    for p in PRINTERS_STATE.values():
        status = "online " if p.online else "OFFLINE"
        mode = p.mode if p.mode == "manual" else f"auto({p.fail_rate:.2f})"
        print(f"  {p.name:<12} :{p.port}  {status}  {mode}")


def cmd_jobs():
    with _lock:
        pending = [j for j in JOBS.values() if j.state == "PENDING"]
    if not pending:
        print("  (nothing waiting)")
        return
    for j in pending:
        head = j.preview[:40].decode("latin-1", "replace").replace("\n", " ")
        print(f"  {j.id:<4} {j.printer.name:<12} {j.age():5.1f}s  "
              f"{j.bytes_seen:>7}B  {head!r}")


def targets(arg):
    if arg == "all":
        with _lock:
            return [j for j in JOBS.values() if j.state == "PENDING"]
    try:
        with _lock:
            return [JOBS[int(arg)]]
    except (KeyError, ValueError):
        print("  no such job")
        return []


def main():
    for name, port in PRINTERS.items():
        p = Printer(name, port)
        PRINTERS_STATE[name] = p
        try:
            p.start()
        except OSError as e:
            print(f"  {name}: could not bind {port} ({e})")
    print(HELP)
    cmd_ls()

    while True:
        try:
            raw = input("> ").strip().split()
        except (EOFError, KeyboardInterrupt):
            break
        if not raw:
            continue
        cmd, args = raw[0].lower(), raw[1:]

        if cmd in ("quit", "exit"):
            break
        elif cmd == "help":
            print(HELP)
        elif cmd == "ls":
            cmd_ls()
        elif cmd == "jobs":
            cmd_jobs()
        elif cmd in ("ok", "fail", "hang") and args:
            delay = float(args[1]) if len(args) > 1 else (
                60.0 if cmd == "hang" else 0.0)
            for j in targets(args[0]):
                j.resolve(cmd, delay)
        elif cmd == "auto" and args:
            p = PRINTERS_STATE.get(args[0])
            if p:
                p.mode = "auto"
                if len(args) > 1:
                    p.fail_rate = float(args[1])
                print(f"  {p.name} -> auto, fail rate {p.fail_rate:.2f}")
        elif cmd == "manual" and args:
            p = PRINTERS_STATE.get(args[0])
            if p:
                p.mode = "manual"
                print(f"  {p.name} -> manual")
        elif cmd in ("offline", "online") and args:
            p = PRINTERS_STATE.get(args[0])
            if p:
                p.stop() if cmd == "offline" else p.start()
                cmd_ls()
        else:
            print("  ?")

    for p in PRINTERS_STATE.values():
        p.stop()


if __name__ == "__main__":
    main()
