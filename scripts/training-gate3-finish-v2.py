from pathlib import Path

source = Path("scripts/training-gate3-finish.py").read_text()
old = """    'if(rule){gross=Math.round(Number(rule.rate_value)*100)/100;status=String(p.payment_status)===\"captured\"&&String(p.booking_status)!==\"cancelled\"?\"earned\":\"held_payment\";hold=status===\"earned\"?null:\"Customer payment is not captured or booking is cancelled\";}',"""
new = """    'if(rule){gross=Math.round(Number(rule.rate_value)*100)/100;status=String(p.payment_status)===\"captured\"?\"earned\":\"held_payment\";hold=status===\"earned\"?null:\"Customer payment is not captured\";}',"""
if old not in source:
    raise SystemExit("Unable to adapt current Training finance patch target")
exec(compile(source.replace(old, new, 1), "training-gate3-finish-v2", "exec"))
