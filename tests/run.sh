#!/bin/sh
# TODO: move the two lines below in some separate config file
TB_OBJDIR=~/Code/objdir-comm-central/
TB_SRCDIR=~/Code/comm-central/
OLD_PWD=`pwd`
PROFD=/tmp/p/

run_all() {
  # Remove startup cache (MOZ_PURGE_CACHES seems to have no effect) to make sure
  # xpcshell is not caching the module we're testing. Actually, blow away the
  # whole profile.
  rm -rf $PROFD
  # Create a fake profile directory
  mkdir -p $PROFD
  # head.js will check this variable to figure out where our fake profile
  # directory should point to
  export XPCSHELL_TEST_PROFILE_DIR=$PROFD
  # Should help
  export MOZ_REPORT_ALL_JS_EXCEPTIONS=1
  # Make it available in the modules/ directory xpcshell will "see"
  \cp ../SimpleStorage.js $TB_OBJDIR/mozilla/dist/bin/modules/
  # Fake a directory structure similar to that of conversations so that the
  # modules SimpleStorage depends on are available
  mkdir -p $TB_OBJDIR/mozilla/dist/bin/conversations/
  \cp ../../log.js $TB_OBJDIR/mozilla/dist/bin/conversations/
  # Jump to the aforementioned objdir
  cd $TB_OBJDIR/mozilla/dist/bin/
  # resource://conversations becomes resources:///conversations
  sed -i 's/resource:\/\/conversations/resource:\/\/\/conversations/' $TB_OBJDIR/mozilla/dist/bin/modules/SimpleStorage.js 
  # here we go, and don't forget that the line number in errors will be
  # augmented with the line count from head.js
  ./xpcshell -f $TB_SRCDIR/mozilla/testing/xpcshell/head.js $OLD_PWD/test_SimpleStorage.js
}

run_all
