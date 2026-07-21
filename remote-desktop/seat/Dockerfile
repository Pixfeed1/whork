# Poste de sourcing : vrai Google Chrome (et non Chromium), pour que les
# extensions du Chrome Web Store (Taleez, Jarvi, ...) et la connexion a un
# compte Google fonctionnent. On repart de l'image streamee linuxserver
# (bureau Selkies deja pret) et on remplace juste le navigateur par Chrome :
# le lanceur de l'image appelle /usr/bin/chromium, qu'on fait pointer sur Chrome.
FROM lscr.io/linuxserver/chromium:latest

RUN apt-get update && \
    apt-get install -y --no-install-recommends wget ca-certificates fonts-liberation && \
    wget -qO /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && \
    (apt-get install -y --no-install-recommends /tmp/chrome.deb || apt-get -f install -y) && \
    rm -f /tmp/chrome.deb && \
    ln -sf /usr/bin/google-chrome-stable /usr/bin/chromium && \
    ln -sf /usr/bin/google-chrome-stable /usr/bin/chromium-browser && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
