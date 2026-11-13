# Lets matt run sudo without a password on the VPS (needed by VPS Manager).
# Prompts for matt's sudo password one last time. visudo -c validates the result;
# the final line should print "root".
ssh -t -p 8365 matt@108.61.96.144 "echo 'matt ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/90-vps-manager >/dev/null && sudo chmod 440 /etc/sudoers.d/90-vps-manager && sudo visudo -c && sudo -n whoami"
