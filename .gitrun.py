#!/usr/bin/env python3
"""Run git/gh with a fresh GitHub app token from the Paperclip broker."""
import base64, json, os, sys, urllib.request

def mint():
    req = urllib.request.Request(
        "http://paperclip-server-1:3100/runtime-tools/github/credentials",
        data=json.dumps({"repository": "itkadr-git/myrmidon"}).encode(),
        headers={
            "x-paperclip-github-capability": os.environ["PAPERCLIP_GITHUB_BROKER_TOKEN"],
            "Content-Type": "application/json",
        }, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

def main():
    env = dict(os.environ)
    creds = mint()
    env.update(creds.get("env", {}))
    if creds.get("token"):
        env["GIT_CONFIG_COUNT"] = "1"
        env["GIT_CONFIG_KEY_0"] = "http.https://github.com/.extraheader"
        env["GIT_CONFIG_VALUE_0"] = "AUTHORIZATION: basic " + base64.b64encode(
            f"x-access-token:{creds['token']}".encode()).decode()
        env["GH_TOKEN"] = creds["token"]
    os.execvpe(sys.argv[1], sys.argv[1:], env)

if __name__ == "__main__":
    main()
