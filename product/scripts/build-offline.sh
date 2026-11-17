#!/bin/sh
set -eu
product_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repository_root=$(dirname "$product_root")
bundle="$product_root/offline"
mvn -B -ntp -f "$product_root/was/pom.xml" "$@" package
mkdir -p "$bundle/lib" "$bundle/web"
mvn -B -ntp -f "$product_root/was/pom.xml" "$@" dependency:copy -Dartifact=org.mariadb.jdbc:mariadb-java-client:4.0.0 "-DoutputDirectory=$bundle/lib"
cp "$product_root/was/target/ROOT.war" "$bundle/ROOT.war"
cp -R "$repository_root/src/web/." "$bundle/web/"
cp -R "$product_root/deploy" "$product_root/db" "$bundle/"
cp "$product_root/.env.example" "$product_root/README.md" "$product_root/VERIFICATION.md" "$bundle/"
cp "$product_root/compose.ftp.yaml" "$bundle/"
sed 's|\./offline/|./|g' "$product_root/compose.yaml" > "$bundle/compose.yaml"
(cd "$bundle"; find . -type f ! -name SHA256SUMS -exec sha256sum {} \; > SHA256SUMS)
printf '%s\n' "Offline artifacts: $bundle (runtime images must be saved separately; see README)"
