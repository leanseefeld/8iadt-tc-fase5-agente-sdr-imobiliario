"""Drive the sample conversations through the running app's own chat API.

    python3 drive.py plan.json [scenario ...]

Each line of the plan is posted to POST /api/chat, as the widget does, and the
script waits for Sofia's reply. It is resumable: lines the session already sent
are skipped, so re-running after an interruption continues where it stopped.
Prints one JSON line per turn. Local demo app only.
"""
import json, os, sys, time, uuid, urllib.request, urllib.parse

BASE = os.environ.get("APP_URL", "http://localhost:3100")
SLUG = "demo"

def post(session, text):
    body = json.dumps({"agencySlug": SLUG, "sessionId": session, "clientMessageId": str(uuid.uuid4()),
                       "text": text, "consent": True}).encode()
    req = urllib.request.Request(f"{BASE}/api/chat", data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())

def _history(session):
    q = urllib.parse.urlencode({"agencySlug": SLUG, "sessionId": session})
    with urllib.request.urlopen(f"{BASE}/api/chat?{q}", timeout=300) as r:
        return json.loads(r.read())

def history(session):
    for _ in range(10):
        try:
            return _history(session)
        except Exception as e:
            print("retry", e, file=sys.stderr); time.sleep(5)
    return _history(session)

def wait_reply(session, seen, timeout=400):
    deadline = time.time() + timeout
    while time.time() < deadline:
        h = history(session)
        msgs = h["messages"]
        if len(msgs) > seen and msgs[-1]["role"] != "lead":
            time.sleep(3)  # let a second bubble land
            h = history(session)
            return h
        time.sleep(2)
    return history(session)

def run(name, session, lines, pause_after=None):
    h0 = history(session)["messages"]
    seen = len(h0)
    done = sum(1 for m in h0 if m["role"] == "lead")
    # The follow-up scenario: the lead goes quiet after `pause_after` lines, and
    # continues only once a follow-up (two agent messages in a row) has gone out.
    if pause_after is not None and done == pause_after:
        if not (len(h0) >= 2 and h0[-1]["role"] == "agent" and h0[-2]["role"] == "agent"):
            print(f"{name}: waiting for a follow-up — press 'Enviar follow-up agora' on this lead, "
                  "wait for it to be sent, then run again", file=sys.stderr)
            return []
    if done and h0[-1]["role"] == "lead":
        h = wait_reply(session, seen - 1); seen = len(h["messages"])
    out = []
    for index, text in enumerate(lines[done:], start=done):
        if pause_after is not None and index == pause_after and done < pause_after:
            print(f"{name}: paused for the follow-up; run again after it is sent", file=sys.stderr)
            break
        t0 = time.time()
        res = post(session, text)
        if not res.get("turn", True) and "text" in res:
            out.append({"lead": text, "agent": [res["text"]], "secs": 0}); continue
        h = wait_reply(session, seen + 1) if res.get("turn") else history(session)
        new = h["messages"][seen:]
        seen = len(h["messages"])
        agent = [m["content"] + (f"  [cards: {len(m['propertyIds'])}]" if m.get("propertyIds") else "")
                 + (f"  [booking: {m['booking']}]" if m.get("booking") else "")
                 for m in new if m["role"] != "lead"]
        out.append({"lead": text, "agent": agent, "secs": round(time.time() - t0)})
        print(json.dumps({"scenario": name, **out[-1]}, ensure_ascii=False), flush=True)
    return out

if __name__ == "__main__":
    plan = json.load(open(sys.argv[1]))
    only = sys.argv[2:]
    for sc in plan:
        if not only or sc["name"] in only:
            run(sc["name"], sc["session"], sc["lines"], sc.get("pauseAfter"))
