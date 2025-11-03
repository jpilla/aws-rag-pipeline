#!/bin/sh
# Lambda debug wrapper: injects Node.js debugger flags
# Lambda bootstrap calls: wrapper.sh /var/lang/bin/node <args...>
# We prepend debug flags to the Node.js command

node_exe="$1"
shift
exec "$node_exe" --enable-source-maps --inspect=0.0.0.0:9229 --inspect-brk "$@"
