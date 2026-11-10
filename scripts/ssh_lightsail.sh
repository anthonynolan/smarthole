#!/bin/bash
# SSH to the shared Lightsail instance (Grimoire + Smarthole).
# Run from anywhere:  bash scripts/ssh_lightsail.sh
ssh ec2-user@34.251.161.194 -i ~/.ssh/LightsailDefaultKey-eu-west-1.pem
