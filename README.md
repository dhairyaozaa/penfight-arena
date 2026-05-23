# 🖊️ PenFight Arena v3

Real-time multiplayer pen-flicking game. **Best of 3 rounds**, 4 maps, 6 pen types.

## Quick Start
```cmd
pip install -r requirements.txt
python generate_sprites.py
python server.py
```
Open **http://localhost:5000** — ngrok URL printed automatically.

## Maps
| Map | Surface | Special |
|-----|---------|---------|
| 🪵 Classic Table | Wood grain | Balanced |
| 🧊 Ice Rink | Smooth ice | Near-zero friction, pens slide forever |
| 📄 Sandpaper | Rough texture | Maximum grip, stops fast |
| 🌀 Portal Maze | Dark mystical | Two portal pairs teleport pens across the table |

## Best-of-3 System
- First to **2 round wins** takes the match
- Round win dots shown above each pen and in the score bar
- Next round starts automatically after 3 seconds
- Host can rematch from the match-over screen

## Controls
- **Drag backward** from your pen → release to shoot
- Drag distance = power (shown in bar)
- **Skip** button fast-forwards physics

## GitHub
```cmd
git init && git add . && git commit -m "feat: PenFight Arena v3"
git remote add origin https://github.com/YOUR_USERNAME/penfight-arena.git
git push -u origin main
```
