#!/bin/bash

# Create the necessary directory
mkdir -p config-server/public

# Copy Config.html to the public/index.html
cp Config.html config-server/public/index.html

# Set proper permissions
chmod 755 config-server/public/index.html

# Verify setup with curl tests
curl -I http://localhost:8080/config-server/public/index.html
