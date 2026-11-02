.PHONY: install test up seed smoke drill down logs triage keycloak-up

install:
	npm install
test:
	npm test
	cd tools/logtriage && python3 -m unittest discover -s tests
up:
	docker compose up -d --build --wait
seed:
	docker compose exec -T api node services/api/src/seed.js
smoke:
	python3 tools/smoke_test.py --base-url http://localhost:8080
drill:
	python3 tools/drill.py --phase-seconds 60
logs:
	docker compose logs --no-log-prefix api gateway worker > out/stack.log
triage:
	cd tools/logtriage && python3 -m logtriage analyze ../../out/stack.log --service api
keycloak-up:
	docker compose -f docker-compose.yml -f docker-compose.keycloak.yml up -d --build --wait
down:
	docker compose -f docker-compose.yml -f docker-compose.keycloak.yml down -v
