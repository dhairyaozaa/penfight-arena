"""
Run this once to regenerate pen sprites in static/assets/.
Usage: python generate_sprites.py
"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), 'static', 'assets')
os.makedirs(OUT, exist_ok=True)

def draw_ballpoint(path):
    img = Image.new('RGBA',(240,64),(0,0,0,0)); d=ImageDraw.Draw(img)
    d.rounded_rectangle([10,18,200,46],radius=14,fill=(43,43,43))
    d.rounded_rectangle([10,18,200,29],radius=14,fill=(90,90,90))
    for i in range(130,180,4): d.rectangle([i,20,i+2,44],fill=(30,30,30))
    d.polygon([(200,18),(200,46),(230,32)],fill=(70,70,70))
    d.polygon([(228,31),(228,33),(235,32)],fill=(180,180,180))
    d.rounded_rectangle([15,14,90,19],radius=3,fill=(100,100,100))
    d.ellipse([4,22,16,42],fill=(60,60,60)); d.ellipse([7,26,13,38],fill=(90,90,90))
    img.save(path)

def draw_gel(path):
    img = Image.new('RGBA',(200,52),(0,0,0,0)); d=ImageDraw.Draw(img)
    d.rounded_rectangle([8,14,175,38],radius=12,fill=(0,188,212,210))
    d.rounded_rectangle([8,14,175,23],radius=12,fill=(77,220,235,160))
    d.rounded_rectangle([50,18,140,34],radius=5,fill=(0,150,170,120))
    d.polygon([(175,14),(175,38),(198,26)],fill=(0,100,120))
    d.polygon([(196,25),(196,27),(200,26)],fill=(220,220,220))
    d.rounded_rectangle([4,16,14,36],radius=6,fill=(0,131,143))
    img.save(path)

def draw_fountain(path):
    img = Image.new('RGBA',(280,80),(0,0,0,0)); d=ImageDraw.Draw(img)
    d.rounded_rectangle([10,16,230,64],radius=18,fill=(139,69,19))
    d.rounded_rectangle([10,16,230,32],radius=18,fill=(180,100,40))
    for x in [28,210]: d.rounded_rectangle([x,14,x+12,66],radius=4,fill=(212,175,55))
    d.rounded_rectangle([220,22,260,58],radius=8,fill=(212,175,55))
    d.polygon([(255,22),(255,58),(272,40)],fill=(180,150,30))
    d.line([(258,38),(272,40)],fill=(100,80,10),width=2)
    d.polygon([(270,39),(270,41),(278,40)],fill=(200,200,200))
    d.rounded_rectangle([20,10,110,16],radius=4,fill=(212,175,55))
    d.ellipse([4,20,18,60],fill=(80,40,10))
    img.save(path)

def draw_marker(path):
    img = Image.new('RGBA',(260,76),(0,0,0,0)); d=ImageDraw.Draw(img)
    d.rounded_rectangle([10,10,220,66],radius=16,fill=(255,87,34))
    d.rounded_rectangle([10,10,220,28],radius=16,fill=(255,138,101))
    d.rounded_rectangle([50,18,170,58],radius=6,fill=(255,255,255))
    for y in [26,34,42,50]: d.line([(58,y),(162,y)],fill=(220,220,220),width=2)
    d.line([(58,26),(162,26)],fill=(191,54,12),width=3)
    d.polygon([(220,10),(220,66),(248,38)],fill=(191,54,12))
    d.polygon([(244,34),(244,42),(254,38)],fill=(80,40,20))
    d.ellipse([4,14,18,62],fill=(191,54,12))
    img.save(path)

def draw_highlighter(path):
    img = Image.new('RGBA',(230,68),(0,0,0,0)); d=ImageDraw.Draw(img)
    d.rounded_rectangle([8,12,195,56],radius=14,fill=(255,235,59,230))
    d.rounded_rectangle([8,12,195,26],radius=14,fill=(255,245,130,200))
    d.polygon([(195,12),(195,56),(222,40),(222,28)],fill=(200,180,20))
    d.rectangle([220,28,228,40],fill=(150,130,10))
    d.rounded_rectangle([4,14,14,54],radius=6,fill=(200,180,20))
    d.rounded_rectangle([40,22,160,46],radius=6,fill=(255,240,50,100))
    img.save(path)

def draw_stylus(path):
    img = Image.new('RGBA',(180,44),(0,0,0,0)); d=ImageDraw.Draw(img)
    d.rounded_rectangle([8,12,155,32],radius=10,fill=(156,39,176))
    d.rounded_rectangle([8,12,155,19],radius=10,fill=(206,147,216))
    for x in range(100,148,6): d.rectangle([x,13,x+3,31],fill=(74,20,140))
    d.polygon([(155,12),(155,32),(170,22)],fill=(192,192,192))
    d.ellipse([168,20,176,24],fill=(220,220,220))
    d.rounded_rectangle([4,14,12,30],radius=4,fill=(74,20,140))
    d.rectangle([5,18,11,26],fill=(192,192,192))
    img.save(path)

for name, fn in [('ballpoint',draw_ballpoint),('gel',draw_gel),
                  ('fountain',draw_fountain),('marker',draw_marker),
                  ('highlighter',draw_highlighter),('stylus',draw_stylus)]:
    p = os.path.join(OUT, f'{name}.png')
    fn(p)
    print(f'✓ {name}.png')
print('Done! Restart server to serve updated sprites.')
