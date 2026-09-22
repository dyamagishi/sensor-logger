"""Mac側で稼働状況を24時間記録する。NanoPiのSDには保存しない。"""
import argparse
import json
import time
import urllib.request
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('--url',required=True,help='監視するセンサーサービスのURL（例: http://nanopi.local:8080）')
parser.add_argument('--hours',type=float,default=24)
parser.add_argument('--output',type=Path,default=Path('artifacts/monitor.jsonl'))
args=parser.parse_args()
args.output.parent.mkdir(parents=True,exist_ok=True)
end=time.monotonic()+args.hours*3600
while time.monotonic()<end:
    record={'checked_at':int(time.time())}
    try:
        with urllib.request.urlopen(args.url+'/api/status',timeout=10) as r:
            record['status']=json.load(r)
    except Exception as e:
        record['error']=str(e)
    with args.output.open('a') as out:
        out.write(json.dumps(record,ensure_ascii=False)+'\n')
    time.sleep(min(60,max(0,end-time.monotonic())))
