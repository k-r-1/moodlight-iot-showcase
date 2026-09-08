#!/bin/zsh

set -eu

script_dir=${0:A:h}
ports=(/dev/cu.usbmodem*(N))

if (( ${#ports} == 0 )); then
  print "ESP32 시리얼 포트를 찾지 못했습니다. 보드의 COM 포트와 데이터 USB 케이블을 확인하세요."
  print "종료하려면 Enter를 누르세요."
  read -r
  exit 1
fi

if (( ${#ports} > 1 )); then
  print "USB modem 포트가 여러 개라 자동 선택하지 않았습니다:"
  printf '  %s\n' "${ports[@]}"
  print "다른 USB modem 장치를 분리한 뒤 다시 실행하세요."
  print "종료하려면 Enter를 누르세요."
  read -r
  exit 1
fi

cd "$script_dir"
print "시리얼 모니터를 시작합니다: ${ports[1]}"
print "로그가 없으면 보드의 RST 버튼을 한 번 누르세요. 종료: Ctrl+]"
exec eim --log-file /private/tmp/moodlight-eim.log run "idf.py -p ${ports[1]} monitor" v5.5.5
