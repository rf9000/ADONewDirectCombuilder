#!/bin/sh
set -e

# The Continia CLI keeps its Azure AD session in ~/.continia/auth.json. Link that
# folder onto the /data volume so `continia auth login` survives a rebuild. Done
# here rather than in the image because an existing volume never receives
# directories the image adds later.
mkdir -p /data/continia
if [ ! -L "$HOME/.continia" ]; then
  rm -rf "$HOME/.continia"
  ln -s /data/continia "$HOME/.continia"
fi

exec "$@"
