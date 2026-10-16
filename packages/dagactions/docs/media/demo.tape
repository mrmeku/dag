# Records demo.gif. From packages/dagactions, with Node 24 on PATH: vhs docs/media/demo.tape
Output docs/media/demo.gif
# The GIF plays this many times faster than the run; the times the run prints stay real.
Set PlaybackSpeed 1.5
Set Shell bash
Set FontSize 15
Set Width 1100
Set Height 560
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Hide
Type "export PS1='$ ' DAGACTIONS_OUTPUT_STYLE=live D=$(mktemp -d) M=$PWD/docs/media; mkdir -p $D/scripts $D/bin $D/node_modules/.bin; ln -s $M/demo-workflow.ts $D/scripts/ci.ts; ln -s $PWD/src/cli.ts $D/node_modules/.bin/dagactions; for t in npm tsc eslint vitest; do ln -s $M/fake-tool.sh $D/bin/$t; done; export PATH=$D/bin:$PATH; cd $D; git init -qb main; git commit -q --allow-empty -m init; clear"
Enter
Show

Type "npx dagactions run scripts/ci.ts"
Sleep 300ms
Enter
Sleep 12s
Type "npx dagactions run scripts/ci.ts"
Sleep 300ms
Enter
Sleep 5s
