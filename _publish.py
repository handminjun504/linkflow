import subprocess, os

os.chdir(r"C:\Users\root\OneDrive\Desktop\unified-access-app")

cred_input = "protocol=https\nhost=github.com\n\n"
result = subprocess.run(
    ["git", "credential", "fill"],
    input=cred_input, capture_output=True, text=True
)
token = None
for line in result.stdout.splitlines():
    if line.startswith("password="):
        token = line.split("=", 1)[1]
        break

if not token:
    print("ERROR: Could not extract GitHub token from git credentials")
    exit(1)

print(f"Token found: {token[:8]}...")
os.environ["GH_TOKEN"] = token

subprocess.run(["git", "add", "-A"], check=True)
try:
    subprocess.run(["git", "commit", "-m", "v2.1.0: team/client management, clients tab"], check=True)
except:
    print("Nothing to commit or commit failed, continuing...")

subprocess.run(["git", "push"], check=True)
print("Git push done. Starting build...")

r = subprocess.run(["npm", "run", "publish"], shell=True)
if r.returncode == 0:
    print("\nBuild and publish SUCCESS!")
else:
    print(f"\nBuild failed with code {r.returncode}")
