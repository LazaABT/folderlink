"""Creates a private GitHub repository, pushes this folder to it and turns on GitHub Pages.

Reads GITHUB_TOKEN and GITHUB_REPO from .env. The token is never printed, written
to git's settings or added to the repository.
"""
import base64
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import build_config

ROOT = Path(__file__).resolve().parent
API = "https://api.github.com"
# Any GitHub token, including old ones that are no longer in .env.
TOKEN_PATTERN = re.compile(rb"gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}")
COMMIT_MESSAGE = (
    "Publish Folderlink\n\n"
    "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n"
)


def stop(message):
    print("Stopped: " + message)
    sys.exit(1)


def api(token, method, path, body=None):
    """Returns (status, parsed JSON). HTTP errors are returned, not raised."""
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(API + path, data=data, method=method, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "folderlink-publish",
    })
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as err:
        status, raw = err.code, err.read()
    except urllib.error.URLError as err:
        stop(f"couldn't reach GitHub ({err.reason}).")
    try:
        return status, json.loads(raw) if raw else {}
    except ValueError:
        return status, {}


def git(*args, env=None):
    result = subprocess.run(
        ["git", *args], cwd=ROOT, env=env, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    if result.returncode:
        stop(f"git {args[0]} failed:\n{result.stdout}")
    return result.stdout


def ensure_repo(token, owner, name, allow_public):
    status, repo = api(token, "GET", f"/repos/{owner}/{name}")
    if status == 200:
        if not repo.get("private") and not allow_public:
            stop(f"{owner}/{name} is public. Set GITHUB_PUBLIC=yes in .env if that's intended.")
        print(f"Using {'private' if repo.get('private') else 'public'} repository {owner}/{name}")
        return
    if status != 404:
        stop(f"couldn't check the repository (GitHub said {status}: {repo.get('message')}).")

    status, repo = api(token, "POST", "/user/repos", {"name": name, "private": True})
    if status != 201:
        stop(f"couldn't create the repository (GitHub said {status}: {repo.get('message')}). "
             "Check that the token has Administration: Read and write.")
    print(f"Created private repository {owner}/{name}")


def commit_files(user):
    if not (ROOT / ".git").exists():
        git("init", "-b", "main")
    git("add", "-A")
    if git("status", "--porcelain").strip():
        email = f"{user['id']}+{user['login']}@users.noreply.github.com"
        git("-c", f"user.name={user['login']}", "-c", f"user.email={email}",
            "commit", "-m", COMMIT_MESSAGE)


def check_no_secrets(token):
    tracked = git("ls-files").split()
    for name in tracked:
        if Path(name).name.startswith(".env") and name != ".env.example":
            stop(f"{name} is about to be committed. Nothing was pushed.")
    for name in tracked:
        content = (ROOT / name).read_bytes()
        if token.encode() in content or TOKEN_PATTERN.search(content):
            stop(f"{name} contains a GitHub token. Nothing was pushed.")
    if TOKEN_PATTERN.search(git("log", "--all", "-p").encode("utf-8", "replace")):
        stop("the commit history contains a GitHub token. Nothing was pushed.")


def push(token, owner, name):
    # Passing the login through the environment keeps it out of .git/config
    # and out of the command line.
    login = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    env = dict(
        os.environ,
        GIT_TERMINAL_PROMPT="0",
        GIT_CONFIG_COUNT="1",
        GIT_CONFIG_KEY_0="http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0="Authorization: Basic " + login,
    )
    result = subprocess.run(
        ["git", "push", f"https://github.com/{owner}/{name}.git", "HEAD:main"],
        cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    if result.returncode:
        stop("the push failed. Check that the token has Contents: Read and write.\n"
             + result.stdout.replace(login, "<hidden>"))
    print("Pushed to main")


def enable_pages(token, owner, name):
    path = f"/repos/{owner}/{name}/pages"
    status, pages = api(token, "POST", path, {"source": {"branch": "main", "path": "/"}})
    if status == 409:
        status, pages = api(token, "GET", path)
    if status in (200, 201):
        return pages.get("html_url") or f"https://{owner}.github.io/{name}/"
    if status == 422:
        stop("the code is pushed, but GitHub won't turn on Pages for this private repository. "
             "Free accounts only get Pages on public repositories, so it needs GitHub Pro, "
             f"or making the repository public. GitHub said: {pages.get('message')}")
    stop(f"the code is pushed, but Pages couldn't be turned on (GitHub said {status}: "
         f"{pages.get('message')}). Check that the token has Pages: Read and write.")


def wait_for_site(token, owner, name):
    for _ in range(30):
        status, pages = api(token, "GET", f"/repos/{owner}/{name}/pages")
        if status == 200 and pages.get("status") == "built":
            return True
        time.sleep(10)
    return False


def main():
    env = build_config.read_env(ROOT / ".env")
    token = env.get("GITHUB_TOKEN")
    name = env.get("GITHUB_REPO") or "folderlink"
    if not token:
        stop("GITHUB_TOKEN is blank in .env.")

    status, user = api(token, "GET", "/user")
    if status != 200:
        stop(f"GitHub didn't accept the token (it said {status}: {user.get('message')}).")
    owner = user["login"]
    print("Signed in to GitHub as " + owner)

    build_config.main()
    ensure_repo(token, owner, name, env.get("GITHUB_PUBLIC") == "yes")
    commit_files(user)
    check_no_secrets(token)
    push(token, owner, name)
    url = enable_pages(token, owner, name)
    print("Pages is on. Waiting for the first build…")
    if wait_for_site(token, owner, name):
        print("Live at " + url)
    else:
        print("Still building. It should appear soon at " + url)


if __name__ == "__main__":
    main()
