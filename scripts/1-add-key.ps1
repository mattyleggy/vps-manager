# Adds this PC's public SSH key to matt's authorized_keys on the VPS.
# Prompts for matt's VPS password (and, on first contact, to confirm the server's host key).
$pub = Join-Path $env:USERPROFILE '.ssh\id_ed25519.pub'
Get-Content $pub | ssh -p 8365 matt@108.61.96.144 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && tr -d '\r' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo KEY_ADDED"
