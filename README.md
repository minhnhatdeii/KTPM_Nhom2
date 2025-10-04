# 1) giải nén & vào thư mục
cd queue-load-leveling-demo

# 2) build & chạy tất cả
docker compose up -d --build
# RabbitMQ UI: http://localhost:15672  (guest/guest)
# Producer API: http://localhost:3000
curl "http://localhost:3000/burst?count=1000&topic=thumbnail.create"
curl "http://localhost:3000/metrics"
# {"queue_depth": 123, "dlq_depth": 0}
docker compose up -d --scale worker=3
